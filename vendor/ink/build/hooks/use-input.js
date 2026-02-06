import { useEffect, useRef } from 'react';
import parseKeypress, { nonAlphanumericKeys } from '../parse-keypress.js';
import reconciler from '../reconciler.js';
import useStdin from './use-stdin.js';

// Patched for bracketed paste: propagate "isPasted" and avoid leaking ESC sequences
// Also patched to use ref for inputHandler to avoid effect churn with inline handlers
const useInput = (inputHandler, options = {}) => {
    const { stdin, setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdin();

    // Store handler in ref to avoid re-subscribing when handler identity changes
    const handlerRef = useRef(inputHandler);
    handlerRef.current = inputHandler;

    useEffect(() => {
        if (options.isActive === false) {
            return;
        }
        setRawMode(true);
        return () => {
            setRawMode(false);
        };
    }, [options.isActive, setRawMode]);

    useEffect(() => {
        if (options.isActive === false) {
            return;
        }

        const handleData = (data) => {
            // Handle bracketed paste events emitted by Ink stdin manager
            if (data && typeof data === 'object' && data.isPasted) {
                const key = {
                    upArrow: false,
                    downArrow: false,
                    leftArrow: false,
                    rightArrow: false,
                    pageDown: false,
                    pageUp: false,
                    return: false,
                    escape: false,
                    ctrl: false,
                    shift: false,
                    tab: false,
                    backspace: false,
                    delete: false,
                    meta: false,
                    isPasted: true
                };
                reconciler.batchedUpdates(() => {
                    handlerRef.current(data.sequence || data.raw || '', key);
                });
                return;
            }

            // Normalize bare \n (Linux Enter) to \r before parsing.
            // parseKeypress maps \r to name:'return' but \n to name:'enter'.
            // Only 'return' should set key.return=true - treating 'enter' as
            // return breaks Shift+Enter on terminals that emit a stray \n
            // alongside the CSI u sequence.
            if (data === '\n') {
                data = '\r';
            }

            let keypress = parseKeypress(data);
            
            // CSI u fallback: iTerm2 3.5+, Kitty, and other modern terminals send
            // keys in CSI u format: ESC [ keycode ; modifier u
            // or with event type: ESC [ keycode ; modifier : event u
            // parseKeypress doesn't handle this, so we parse it ourselves as a fallback
            if (!keypress.name && typeof data === 'string') {
                let keycode = null;
                let modifier = 0;
                let event = 1;

                // Match CSI u: ESC [ keycode ; modifier u  OR  ESC [ keycode ; modifier : event u
                const csiUMatch = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?u$/);
                if (csiUMatch) {
                    keycode = parseInt(csiUMatch[1], 10);
                    modifier = parseInt(csiUMatch[2] || '1', 10) - 1;
                    event = csiUMatch[3] ? parseInt(csiUMatch[3], 10) : 1;
                } else {
                    // modifyOtherKeys format: CSI 27 ; modifier ; key ~
                    // Treat it like CSI u (key + 'u')
                    const modifyOtherKeysMatch = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
                    if (modifyOtherKeysMatch) {
                        modifier = parseInt(modifyOtherKeysMatch[1], 10) - 1;
                        keycode = parseInt(modifyOtherKeysMatch[2], 10);
                    }
                }

                if (keycode !== null) {
                    // Ignore key release events (event=3)
                    if (event === 3) {
                        return;
                    }

                    // Map keycodes to names
                    const csiUKeyMap = {
                        9: 'tab',
                        13: 'return',
                        27: 'escape',
                        127: 'backspace',
                    };

                    let name = csiUKeyMap[keycode] || '';

                    // Handle letter keycodes (a-z: 97-122, A-Z: 65-90)
                    if (!name && keycode >= 97 && keycode <= 122) {
                        name = String.fromCharCode(keycode); // lowercase letter
                    } else if (!name && keycode >= 65 && keycode <= 90) {
                        name = String.fromCharCode(keycode + 32); // convert to lowercase
                    }

                    if (name) {
                        keypress = {
                            name,
                            ctrl: !!(modifier & 4),
                            meta: !!(modifier & 10),
                            shift: !!(modifier & 1),
                            option: false,
                            sequence: data,
                            raw: data,
                        };
                    }
                }
            }
            
            const key = {
                upArrow: keypress.name === 'up',
                downArrow: keypress.name === 'down',
                leftArrow: keypress.name === 'left',
                rightArrow: keypress.name === 'right',
                pageDown: keypress.name === 'pagedown',
                pageUp: keypress.name === 'pageup',
                return: keypress.name === 'return',
                escape: keypress.name === 'escape',
                ctrl: keypress.ctrl,
                shift: keypress.shift,
                tab: keypress.name === 'tab',
                backspace: keypress.name === 'backspace',
                delete: keypress.name === 'delete',
                meta: keypress.meta || keypress.name === 'escape' || keypress.option,
                isPasted: false
            };

            // Debug logging for key parsing (LETTA_DEBUG_KEYS=1)
            if (process.env.LETTA_DEBUG_KEYS === '1') {
                const rawHex = typeof data === 'string'
                    ? [...data].map(c => '0x' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')
                    : '(non-string)';
                // eslint-disable-next-line no-console
                console.error(`[debug:ink-keypress] raw=${rawHex} name="${keypress.name}" seq="${keypress.sequence}" key={escape:${key.escape},tab:${key.tab},shift:${key.shift},ctrl:${key.ctrl},meta:${key.meta}}`);
            }

            let input = keypress.ctrl ? keypress.name : keypress.sequence;
            const seq = typeof keypress.sequence === 'string' ? keypress.sequence : '';
            // Filter xterm focus in/out sequences (ESC[I / ESC[O)
            if (seq === '\u001B[I' || seq === '\u001B[O' || input === '[I' || input === '[O' || /^(?:\[I|\[O)+$/.test(input || '')) {
                return;
            }

            if (nonAlphanumericKeys.includes(keypress.name)) {
                input = '';
            }

            if (input.length === 1 && typeof input[0] === 'string' && /[A-Z]/.test(input[0])) {
                key.shift = true;
            }

            if (!(input === 'c' && key.ctrl) || !internal_exitOnCtrlC) {
                reconciler.batchedUpdates(() => {
                    handlerRef.current(input, key);
                });
            }
        };

        internal_eventEmitter?.on('input', handleData);
        return () => {
            internal_eventEmitter?.removeListener('input', handleData);
        };
    }, [options.isActive, stdin, internal_exitOnCtrlC]);
};

export default useInput;
