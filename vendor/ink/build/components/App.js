import { EventEmitter } from 'node:events';
import process from 'node:process';
import cliCursor from 'cli-cursor';
import React, { PureComponent } from 'react';
import AppContext from './AppContext.js';
import ErrorOverview from './ErrorOverview.js';
import FocusContext from './FocusContext.js';
import StderrContext from './StderrContext.js';
import StdinContext from './StdinContext.js';
import StdoutContext from './StdoutContext.js';

const tab = '\t';
const shiftTab = '\u001B[Z';
const escape = '\u001B';
export default class App extends PureComponent {
    static displayName = 'InternalApp';
    static getDerivedStateFromError(error) {
        return { error };
    }
    state = {
        isFocusEnabled: true,
        activeFocusId: undefined,
        focusables: [],
        error: undefined,
    };
    rawModeEnabledCount = 0;
    // Increase max listeners to accommodate multiple useInput hooks across components
    internal_eventEmitter = (() => {
        const emitter = new EventEmitter();
        emitter.setMaxListeners(20);
        return emitter;
    })();
    isRawModeSupported() {
        return this.props.stdin.isTTY;
    }
    render() {
        return (React.createElement(AppContext.Provider, { value: { exit: this.handleExit } },
            React.createElement(StdinContext.Provider, { value: { stdin: this.props.stdin, setRawMode: this.handleSetRawMode, isRawModeSupported: this.isRawModeSupported(), internal_exitOnCtrlC: this.props.exitOnCtrlC, internal_eventEmitter: this.internal_eventEmitter } },
                React.createElement(StdoutContext.Provider, { value: { stdout: this.props.stdout, write: this.props.writeToStdout } },
                    React.createElement(StderrContext.Provider, { value: { stderr: this.props.stderr, write: this.props.writeToStderr } },
                        React.createElement(FocusContext.Provider, { value: { activeId: this.state.activeFocusId, add: this.addFocusable, remove: this.removeFocusable, activate: this.activateFocusable, deactivate: this.deactivateFocusable, enableFocus: this.enableFocus, disableFocus: this.disableFocus, focusNext: this.focusNext, focusPrevious: this.focusPrevious, focus: this.focus } }, this.state.error ? (React.createElement(ErrorOverview, { error: this.state.error })) : (this.props.children)))))));
    }
    componentDidMount() {
        cliCursor.hide(this.props.stdout);
        // Increase max listeners on stdin to accommodate multiple useInput hooks
        if (this.props.stdin?.setMaxListeners) {
            this.props.stdin.setMaxListeners(20);
        }
    }
    componentWillUnmount() {
        cliCursor.show(this.props.stdout);
        if (this.isRawModeSupported()) {
            this.handleSetRawMode(false);
        }
    }
    componentDidCatch(error) {
        this.handleExit(error);
    }
    handleSetRawMode = (isEnabled) => {
        const { stdin } = this.props;
        if (!this.isRawModeSupported()) {
            if (stdin === process.stdin) {
                throw new Error('Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported');
            }
            else {
                throw new Error('Raw mode is not supported on the stdin provided to Ink.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported');
            }
        }
        // Increase max listeners on stdin to accommodate multiple useInput hooks
        stdin.setMaxListeners(20);
        stdin.setEncoding('utf8');
        if (isEnabled) {
            if (this.rawModeEnabledCount === 0) {
                stdin.ref();
                stdin.setRawMode(true);
                stdin.addListener('readable', this.handleReadable);
                // Enable bracketed paste on this TTY
                this.props.stdout?.write('\x1B[?2004h');
            }
            this.rawModeEnabledCount++;
            return;
        }
        if (--this.rawModeEnabledCount === 0) {
            this.props.stdout?.write('\x1B[?2004l');
            stdin.setRawMode(false);
            stdin.removeListener('readable', this.handleReadable);
            stdin.unref();
        }
    };
    keyParseState = { mode: 'NORMAL', incomplete: '', pasteBuffer: '' };
    fallbackPaste = { aggregating: false, buffer: '', timer: null, lastAt: 0, chunks: 0, bytes: 0, escalated: false, recentTime: 0, recentLen: 0 };
    FALLBACK_NORMAL_MS = 16;
    FALLBACK_PASTE_MS = 150;
    PLACEHOLDER_LINE_THRESHOLD = 5;
    PLACEHOLDER_CHAR_THRESHOLD = 500;
    FALLBACK_START_LEN_THRESHOLD = 200;
    parseChunk = (state, chunk) => {
        const START = '\x1B[200~';
        const END = '\x1B[201~';
        const events = [];
        let next = { ...state };
        let buf = (next.incomplete || '') + (chunk || '');
        next.incomplete = '';
        const pushText = (text) => {
            if (text && text.length > 0) {
                events.push({ type: 'text', value: text });
            }
        };
        if (next.mode === 'NORMAL') {
            let offset = 0;
            while (offset < buf.length) {
                const startIdx = buf.indexOf(START, offset);
                if (startIdx === -1) {
                    const remainder = buf.slice(offset);
                    let keep = 0;
                    const max = Math.min(remainder.length, START.length - 1);
                    // Only keep potential START prefixes of length >= 2 (e.g., "\x1B[") to avoid swallowing a bare ESC
                    for (let i = max; i > 1; i--) {
                        if (START.startsWith(remainder.slice(-i))) {
                            keep = i;
                            break;
                        }
                    }
                    if (remainder.length > keep) {
                        pushText(remainder.slice(0, remainder.length - keep));
                    }
                    next.incomplete = remainder.slice(remainder.length - keep);
                    break;
                }
                if (startIdx > offset) {
                    pushText(buf.slice(offset, startIdx));
                }
                offset = startIdx + START.length;
                const endIdx = buf.indexOf(END, offset);
                if (endIdx !== -1) {
                    const content = buf.slice(offset, endIdx);
                    events.push({ type: 'paste', value: content });
                    offset = endIdx + END.length;
                    continue;
                }
                next.mode = 'IN_PASTE';
                next.pasteBuffer = buf.slice(offset);
                break;
            }
            return [events, next];
        }
        if (next.mode === 'IN_PASTE') {
            next.pasteBuffer += buf;
            const endIdx = next.pasteBuffer.indexOf(END);
            if (endIdx === -1) {
                return [events, next];
            }
            const content = next.pasteBuffer.slice(0, endIdx);
            events.push({ type: 'paste', value: content });
            const after = next.pasteBuffer.slice(endIdx + END.length);
            next.mode = 'NORMAL';
            next.pasteBuffer = '';
            const [moreEvents, finalState] = this.parseChunk(next, after);
            return [events.concat(moreEvents), finalState];
        }
        return [events, next];
    };
    countLines = (text) => {
        if (!text)
            return 0;
        const m = text.match(/\r\n|\r|\n/g);
        return (m ? m.length : 0);
    };
    fallbackStart = () => {
        this.fallbackStop();
        this.fallbackPaste.aggregating = true;
        this.fallbackPaste.buffer = '';
        this.fallbackPaste.chunks = 0;
        this.fallbackPaste.bytes = 0;
        this.fallbackPaste.escalated = false;
        this.fallbackPaste.lastAt = Date.now();
        this.fallbackPaste.timer = setTimeout(this.fallbackFlush, this.FALLBACK_NORMAL_MS);
    };
    fallbackSchedule = (ms) => {
        if (this.fallbackPaste.timer)
            clearTimeout(this.fallbackPaste.timer);
        this.fallbackPaste.timer = setTimeout(this.fallbackFlush, ms);
        this.fallbackPaste.lastAt = Date.now();
    };
    fallbackStop = () => {
        if (this.fallbackPaste.timer)
            clearTimeout(this.fallbackPaste.timer);
        this.fallbackPaste.timer = null;
        this.fallbackPaste.aggregating = false;
    };
    fallbackFlush = () => {
        const txt = this.fallbackPaste.buffer;
        this.fallbackStop();
        if (!txt)
            return;
        const lines = this.countLines(txt);
        const isPaste = this.fallbackPaste.escalated || (lines > this.PLACEHOLDER_LINE_THRESHOLD) || (txt.length > this.PLACEHOLDER_CHAR_THRESHOLD);
        if (isPaste) {
            const pasteEvent = { sequence: txt, raw: txt, isPasted: true, name: '', ctrl: false, meta: false, shift: false };
            this.internal_eventEmitter.emit('input', pasteEvent);
        }
        else {
            this.handleInput(txt);
            this.internal_eventEmitter.emit('input', txt);
        }
        this.fallbackPaste.buffer = '';
        this.fallbackPaste.chunks = 0;
        this.fallbackPaste.bytes = 0;
        this.fallbackPaste.escalated = false;
    };
    handleReadable = () => {
        let chunk;
        while ((chunk = this.props.stdin.read()) !== null) {
            const [events, nextState] = this.parseChunk(this.keyParseState, chunk);
            this.keyParseState = nextState;
            for (const evt of events) {
                if (evt.type === 'paste') {
                    if (this.fallbackPaste.aggregating) {
                        this.fallbackFlush();
                    }
                    const content = evt.value;
                    const pasteEvent = { sequence: content, raw: content, isPasted: true, name: '', ctrl: false, meta: false, shift: false };
                    this.internal_eventEmitter.emit('input', pasteEvent);
                }
                else if (evt.type === 'text') {
                    const text = evt.value;
                    if (!text)
                        continue;
                    const hasNewline = /\r|\n/.test(text);
                    if (this.fallbackPaste.aggregating) {
                        this.fallbackPaste.buffer += text;
                        this.fallbackPaste.chunks += 1;
                        this.fallbackPaste.bytes += text.length;
                        if (!this.fallbackPaste.escalated) {
                            if (this.fallbackPaste.buffer.length >= 128) {
                                this.fallbackPaste.escalated = true;
                            }
                        }
                        this.fallbackSchedule(this.fallbackPaste.escalated ? this.FALLBACK_PASTE_MS : this.FALLBACK_NORMAL_MS);
                        continue;
                    }
                    const now = Date.now();
                    const quickCombo = (now - this.fallbackPaste.recentTime) <= 16 && (this.fallbackPaste.recentLen + text.length) >= 128;
                    if (text.length >= 128 || quickCombo) {
                        this.fallbackStart();
                        this.fallbackPaste.buffer += text;
                        this.fallbackPaste.chunks = 1;
                        this.fallbackPaste.bytes = text.length;
                        this.fallbackPaste.escalated = text.length >= 128;
                        this.fallbackSchedule(this.FALLBACK_PASTE_MS);
                        continue;
                    }
                    this.handleInput(text);
                    this.internal_eventEmitter.emit('input', text);
                    this.fallbackPaste.recentTime = Date.now();
                    this.fallbackPaste.recentLen = text.length;
                    continue;
                }
            }
        }
    };
    handleInput = (input) => {
        if (input === '\x03' && this.props.exitOnCtrlC) {
            this.handleExit();
        }
        // Disable ESC-based focus clearing to avoid consuming the first Escape
        // if (input === escape && this.state.activeFocusId) {
        //     this.setState({ activeFocusId: undefined });
        // }
        if (this.state.isFocusEnabled && this.state.focusables.length > 0) {
            if (input === tab) {
                this.focusNext();
            }
            if (input === shiftTab) {
                this.focusPrevious();
            }
        }
    };
    handleExit = (error) => {
        if (this.isRawModeSupported()) {
            this.handleSetRawMode(false);
        }
        this.props.onExit(error);
    };
    enableFocus = () => {
        this.setState({ isFocusEnabled: true });
    };
    disableFocus = () => {
        this.setState({ isFocusEnabled: false });
    };
    focus = (id) => {
        this.setState(previousState => {
            const hasFocusableId = previousState.focusables.some(focusable => focusable?.id === id);
            if (!hasFocusableId) {
                return previousState;
            }
            return { activeFocusId: id };
        });
    };
    focusNext = () => {
        this.setState(previousState => {
            const firstFocusableId = previousState.focusables.find(focusable => focusable.isActive)?.id;
            const nextFocusableId = this.findNextFocusable(previousState);
            return { activeFocusId: nextFocusableId ?? firstFocusableId };
        });
    };
    focusPrevious = () => {
        this.setState(previousState => {
            const lastFocusableId = previousState.focusables.findLast(focusable => focusable.isActive)?.id;
            const previousFocusableId = this.findPreviousFocusable(previousState);
            return { activeFocusId: previousFocusableId ?? lastFocusableId };
        });
    };
    addFocusable = (id, { autoFocus }) => {
        this.setState(previousState => {
            let nextFocusId = previousState.activeFocusId;
            if (!nextFocusId && autoFocus) {
                nextFocusId = id;
            }
            return { activeFocusId: nextFocusId, focusables: [...previousState.focusables, { id, isActive: true }] };
        });
    };
    removeFocusable = (id) => {
        this.setState(previousState => ({ activeFocusId: previousState.activeFocusId === id ? undefined : previousState.activeFocusId, focusables: previousState.focusables.filter(focusable => focusable.id !== id) }));
    };
    activateFocusable = (id) => {
        this.setState(previousState => ({ focusables: previousState.focusables.map(focusable => (focusable.id !== id ? focusable : { id, isActive: true })) }));
    };
    deactivateFocusable = (id) => {
        this.setState(previousState => ({ activeFocusId: previousState.activeFocusId === id ? undefined : previousState.activeFocusId, focusables: previousState.focusables.map(focusable => (focusable.id !== id ? focusable : { id, isActive: false })) }));
    };
    findNextFocusable = (state) => {
        const activeIndex = state.focusables.findIndex(focusable => {
            return focusable.id === state.activeFocusId;
        });
        for (let index = activeIndex + 1; index < state.focusables.length; index++) {
            const focusable = state.focusables[index];
            if (focusable?.isActive) {
                return focusable.id;
            }
        }
        return undefined;
    };
    findPreviousFocusable = (state) => {
        const activeIndex = state.focusables.findIndex(focusable => {
            return focusable.id === state.activeFocusId;
        });
        for (let index = activeIndex - 1; index >= 0; index--) {
            const focusable = state.focusables[index];
            if (focusable?.isActive) {
                return focusable.id;
            }
        }
        return undefined;
    };
}
//# sourceMappingURL=App.js.map


