import chalk from 'chalk';
import { Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';

/**
 * Determines if the input should be treated as a control sequence (not inserted as text).
 * This centralizes escape sequence filtering to prevent garbage characters from being inserted.
 */
function isControlSequence(input, key) {
    // Pasted content is handled separately
    if (key?.isPasted) return true;

    // Standard control keys (but NOT plain escape - apps may need it for shortcuts)
    if (key.tab || (key.ctrl && input === 'c')) return true;
    if (key.shift && key.tab) return true;

    // Ctrl+W (delete word) - handled by parent component
    if (key.ctrl && (input === 'w' || input === 'W')) return true;

    // Option+Arrow escape sequences: Ink parses \x1bb as meta=true, input='b'
    if (key.meta && (input === 'b' || input === 'B' || input === 'f' || input === 'F')) return true;

    // Filter specific escape sequences that would insert garbage, but allow plain ESC through
    // CSI sequences (ESC[...), Option+Delete (ESC + DEL), and other multi-char escape sequences
    if (input && typeof input === 'string' && input.startsWith('\x1b') && input.length > 1) return true;

    return false;
}

function TextInput({ value: originalValue, placeholder = '', focus = true, mask, highlightPastedText = false, showCursor = true, onChange, onSubmit, externalCursorOffset, onCursorOffsetChange }) {
    const [state, setState] = useState({ cursorOffset: (originalValue || '').length, cursorWidth: 0 });
    const { cursorOffset, cursorWidth } = state;
    useEffect(() => {
        setState(previousState => {
            if (!focus || !showCursor) {
                return previousState;
            }
            const newValue = originalValue || '';
            if (previousState.cursorOffset > newValue.length - 1) {
                return { cursorOffset: newValue.length, cursorWidth: 0 };
            }
            return previousState;
        });
    }, [originalValue, focus, showCursor]);
    useEffect(() => {
        if (typeof externalCursorOffset === 'number') {
            const newValue = originalValue || '';
            const clamped = Math.max(0, Math.min(externalCursorOffset, newValue.length));
            setState(prev => ({ cursorOffset: clamped, cursorWidth: 0 }));
            if (typeof onCursorOffsetChange === 'function') onCursorOffsetChange(clamped);
        }
    }, [externalCursorOffset, originalValue, onCursorOffsetChange]);
    const cursorActualWidth = highlightPastedText ? cursorWidth : 0;
    const value = mask ? mask.repeat(originalValue.length) : originalValue;
    let renderedValue = value;
    let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;
    if (showCursor && focus) {
        renderedPlaceholder = placeholder.length > 0 ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1)) : chalk.inverse(' ');
        renderedValue = value.length > 0 ? '' : chalk.inverse(' ');
        let i = 0;
        for (const char of value) {
            renderedValue += i >= cursorOffset - cursorActualWidth && i <= cursorOffset ? chalk.inverse(char) : char;
            i++;
        }
        if (value.length > 0 && cursorOffset === value.length) {
            renderedValue += chalk.inverse(' ');
        }
    }
    useInput((input, key) => {
        // Filter control sequences (escape keys, Option+Arrow garbage, etc.)
        if (isControlSequence(input, key)) {
            return;
        }
        if (key.return) {
            if (onSubmit) {
                onSubmit(originalValue);
            }
            return;
        }
        let nextCursorOffset = cursorOffset;
        let nextValue = originalValue;
        let nextCursorWidth = 0;
        if (key.leftArrow || key.rightArrow) {
            // Skip if meta is pressed - Option+Arrow is handled by parent for word navigation
            if (key.meta) {
                return;
            }
            if (showCursor) {
                nextCursorOffset += key.leftArrow ? -1 : 1;
            }
        }
        else if (key.upArrow || key.downArrow) {
            // Let parent decide (wrapped line navigation)
            return;
        }
        else if (key.backspace || key.delete) {
            // Skip if meta is pressed - Option+Delete is handled by parent for word deletion
            if (key.meta) {
                return;
            }
            if (cursorOffset > 0) {
                nextValue = originalValue.slice(0, cursorOffset - 1) + originalValue.slice(cursorOffset, originalValue.length);
                nextCursorOffset--;
            }
        }
        else if (key.ctrl && input === 'a') {
            // CTRL-A: jump to beginning of line
            if (showCursor) {
                nextCursorOffset = 0;
            }
        }
        else if (key.ctrl && input === 'e') {
            // CTRL-E: jump to end of line
            if (showCursor) {
                nextCursorOffset = originalValue.length;
            }
        }
        else {
            nextValue = originalValue.slice(0, cursorOffset) + input + originalValue.slice(cursorOffset, originalValue.length);
            nextCursorOffset += input.length;
            if (input.length > 1) {
                nextCursorWidth = input.length;
            }
        }
        nextCursorOffset = Math.max(0, Math.min(nextCursorOffset, nextValue.length));
        setState({ cursorOffset: nextCursorOffset, cursorWidth: nextCursorWidth });
        if (typeof onCursorOffsetChange === 'function') onCursorOffsetChange(nextCursorOffset);
        if (nextValue !== originalValue) {
            onChange(nextValue);
        }
    }, { isActive: focus });
    return (React.createElement(Text, null, placeholder ? (value.length > 0 ? renderedValue : renderedPlaceholder) : renderedValue));
}
export default TextInput;
export function UncontrolledTextInput({ initialValue = '', ...props }) {
    const [value, setValue] = useState(initialValue);
    return React.createElement(TextInput, { ...props, value: value, onChange: setValue });
}
