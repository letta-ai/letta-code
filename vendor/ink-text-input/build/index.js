import chalk from 'chalk';
import { Box, Text, useInput } from 'ink';
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

    // Filter out other ctrl+letter combinations that aren't handled below (e.g., ctrl+o for subagent expand)
    // The handled ones are: ctrl+a, ctrl+e, ctrl+k, ctrl+u, ctrl+y (see useInput below)
    if (key.ctrl && input && /^[a-z]$/i.test(input) && !['a', 'e', 'k', 'u', 'y'].includes(input.toLowerCase())) return true;

    // Option+Arrow escape sequences: Ink parses \x1bb as meta=true, input='b'
    if (key.meta && (input === 'b' || input === 'B' || input === 'f' || input === 'F')) return true;

    // Filter specific escape sequences that would insert garbage, but allow plain ESC through
    // CSI sequences (ESC[...), Option+Delete (ESC + DEL), and other multi-char escape sequences
    if (input && typeof input === 'string' && input.startsWith('\x1b') && input.length > 1) return true;

    return false;
}

function TextInput({ value: originalValue, placeholder = '', focus = true, mask, highlightPastedText = false, showCursor = true, onChange, onSubmit, externalCursorOffset, onCursorOffsetChange }) {
    const [state, setState] = useState({ cursorOffset: (originalValue || '').length, cursorWidth: 0, killBuffer: '' });
    const { cursorOffset, cursorWidth, killBuffer } = state;
    useEffect(() => {
        setState(previousState => {
            if (!focus || !showCursor) {
                return previousState;
            }
            const newValue = originalValue || '';
            if (previousState.cursorOffset > newValue.length - 1) {
                return { ...previousState, cursorOffset: newValue.length, cursorWidth: 0 };
            }
            return previousState;
        });
    }, [originalValue, focus, showCursor]);
    useEffect(() => {
        if (typeof externalCursorOffset === 'number') {
            const newValue = originalValue || '';
            const clamped = Math.max(0, Math.min(externalCursorOffset, newValue.length));
            setState(prev => ({ ...prev, cursorOffset: clamped, cursorWidth: 0 }));
            if (typeof onCursorOffsetChange === 'function') onCursorOffsetChange(clamped);
        }
    }, [externalCursorOffset, originalValue, onCursorOffsetChange]);
    const cursorActualWidth = highlightPastedText ? cursorWidth : 0;
    const value = mask ? mask.repeat(originalValue.length) : originalValue;
    
    // Split value by newlines for multiline rendering
    const lines = value.split('\n');
    const renderedLines = [];
    
    // Track cursor position across lines
    let charCount = 0;
    
    if (showCursor && focus) {
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            let renderedLine = '';
            
            for (let i = 0; i < line.length; i++) {
                const globalIdx = charCount + i;
                const char = line[i];
                renderedLine += globalIdx >= cursorOffset - cursorActualWidth && globalIdx <= cursorOffset ? chalk.inverse(char) : char;
            }
            
            // Add cursor at end of line if needed
            const lineEnd = charCount + line.length;
            if (cursorOffset === lineEnd && (lineIdx === lines.length - 1 || cursorOffset < value.length)) {
                renderedLine += chalk.inverse(' ');
            }
            
            renderedLines.push(renderedLine || ' ');
            charCount += line.length + 1; // +1 for the newline character
        }
        
        // Handle empty input with placeholder
        if (value.length === 0 && placeholder) {
            renderedLines[0] = placeholder.length > 0 ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1)) : chalk.inverse(' ');
        }
    } else {
        // No cursor, just render the lines
        for (const line of lines) {
            renderedLines.push(line || ' ');
        }
        
        if (value.length === 0 && placeholder) {
            renderedLines[0] = chalk.grey(placeholder);
        }
    }
    useInput((input, key) => {
        // Filter control sequences (escape keys, Option+Arrow garbage, etc.)
        if (isControlSequence(input, key)) {
            return;
        }
        
        // Ctrl+J or Ctrl+Enter as alternative newline insertion (more reliable than Shift+Enter)
        if ((key.ctrl && input === 'j') || (key.ctrl && input === 'J') || (key.ctrl && key.return)) {
            const nextValue = originalValue.slice(0, cursorOffset) + '\n' + originalValue.slice(cursorOffset, originalValue.length);
            const nextCursorOffset = cursorOffset + 1;
            setState(prev => ({ ...prev, cursorOffset: nextCursorOffset, cursorWidth: 0 }));
            if (typeof onCursorOffsetChange === 'function') onCursorOffsetChange(nextCursorOffset);
            onChange(nextValue);
            return;
        }
        
        if (key.return) {
            // Shift+Enter inserts a newline instead of submitting (if terminal supports it)
            if (key.shift) {
                const nextValue = originalValue.slice(0, cursorOffset) + '\n' + originalValue.slice(cursorOffset, originalValue.length);
                const nextCursorOffset = cursorOffset + 1;
                setState(prev => ({ ...prev, cursorOffset: nextCursorOffset, cursorWidth: 0 }));
                if (typeof onCursorOffsetChange === 'function') onCursorOffsetChange(nextCursorOffset);
                onChange(nextValue);
                return;
            }
            // Backslash+Enter: remove trailing backslash and insert newline
            if (cursorOffset > 0 && originalValue[cursorOffset - 1] === '\\') {
                const nextValue = originalValue.slice(0, cursorOffset - 1) + '\n' + originalValue.slice(cursorOffset, originalValue.length);
                const nextCursorOffset = cursorOffset; // Cursor stays at same position (backslash removed, newline added)
                setState(prev => ({ ...prev, cursorOffset: nextCursorOffset, cursorWidth: 0 }));
                if (typeof onCursorOffsetChange === 'function') onCursorOffsetChange(nextCursorOffset);
                onChange(nextValue);
                return;
            }
            // Regular Enter submits
            if (onSubmit) {
                onSubmit(originalValue);
            }
            return;
        }
        let nextCursorOffset = cursorOffset;
        let nextValue = originalValue;
        let nextCursorWidth = 0;
        let nextKillBuffer = killBuffer;
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
        else if (key.ctrl && input === 'k') {
            // CTRL-K: kill from cursor to end of line
            if (cursorOffset < originalValue.length) {
                nextKillBuffer = originalValue.slice(cursorOffset);
                nextValue = originalValue.slice(0, cursorOffset);
            }
        }
        else if (key.ctrl && input === 'u') {
            // CTRL-U: kill from beginning to cursor
            if (cursorOffset > 0) {
                nextKillBuffer = originalValue.slice(0, cursorOffset);
                nextValue = originalValue.slice(cursorOffset);
                nextCursorOffset = 0;
            }
        }
        else if (key.ctrl && input === 'y') {
            // CTRL-Y: yank (paste) from kill buffer
            if (killBuffer) {
                nextValue = originalValue.slice(0, cursorOffset) + killBuffer + originalValue.slice(cursorOffset);
                nextCursorOffset = cursorOffset + killBuffer.length;
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
        setState(prev => ({ ...prev, cursorOffset: nextCursorOffset, cursorWidth: nextCursorWidth, killBuffer: nextKillBuffer }));
        if (typeof onCursorOffsetChange === 'function') onCursorOffsetChange(nextCursorOffset);
        if (nextValue !== originalValue) {
            onChange(nextValue);
        }
    }, { isActive: focus });
    
    // Render multiline input
    if (renderedLines.length === 1) {
        return React.createElement(Text, null, renderedLines[0]);
    }
    
    return React.createElement(Box, { flexDirection: 'column' }, 
        renderedLines.map((line, idx) => React.createElement(Text, { key: idx }, line))
    );
}
export default TextInput;
export function UncontrolledTextInput({ initialValue = '', ...props }) {
    const [value, setValue] = useState(initialValue);
    return React.createElement(TextInput, { ...props, value: value, onChange: setValue });
}
