import { useEffect } from 'react';
import parseKeypress, { nonAlphanumericKeys } from '../parse-keypress.js';
import reconciler from '../reconciler.js';
import useStdin from './use-stdin.js';

// Patched for bracketed paste: propagate "isPasted" and avoid leaking ESC sequences
const useInput = (inputHandler, options = {}) => {
    const { stdin, setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdin();

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
                    inputHandler(data.sequence || data.raw || '', key);
                });
                return;
            }

            const keypress = parseKeypress(data);
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
                    inputHandler(input, key);
                });
            }
        };

        internal_eventEmitter?.on('input', handleData);
        return () => {
            internal_eventEmitter?.removeListener('input', handleData);
        };
    }, [options.isActive, stdin, internal_exitOnCtrlC, inputHandler]);
};

export default useInput;


