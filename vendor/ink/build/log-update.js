import ansiEscapes from 'ansi-escapes';
import cliCursor from 'cli-cursor';
import stringWidth from 'string-width';
import {
    buildCursorSuffix,
    buildCursorOnlySequence,
    buildReturnToBottomPrefix,
    cursorPositionChanged,
} from './cursor-helpers.js';

const create = (stream, { showCursor = false } = {}) => {
    let previousLineCount = 0;
    let previousOutput = '';
    let hasHiddenCursor = false;
    let cursorPosition = undefined;
    let previousCursorPosition = undefined;
    let cursorShown = false;

    const renderWithClearedLineEnds = (output) => {
        // On some terminals, writing to the last column leaves the cursor in a
        // deferred-wrap state where CSI K (Erase in Line) erases the character
        // at the final column instead of being a no-op.  Skip the erase for
        // lines that already fill the terminal width — there is nothing beyond
        // them to clean up.
        const cols = stream.columns || 80;
        const lines = output.split('\n');
        return lines.map((line) => {
            if (stringWidth(line) >= cols) return line;
            return line + ansiEscapes.eraseEndLine;
        }).join('\n');
    };

    const render = (str) => {
        if (!showCursor && !hasHiddenCursor) {
            cliCursor.hide();
            hasHiddenCursor = true;
        }

        const output = str + '\n';
        const cursorChanged = cursorPositionChanged(cursorPosition, previousCursorPosition);

        if (output === previousOutput && !cursorChanged) {
            return false;
        }

        const nextLineCount = output.split('\n').length;
        // visibleLineCount = number of visible lines (excluding trailing empty from split)
        const visibleLineCount = nextLineCount - 1;

        if (output !== previousOutput) {
            // Rerender content: first return cursor to bottom if it was positioned,
            // then move to top and repaint in place.
            const returnPrefix = buildReturnToBottomPrefix(cursorShown, previousLineCount, previousCursorPosition);

            // Avoid eraseLines() pre-clear flashes by repainting in place:
            // move to start of previous frame, rewrite each line while erasing EOL,
            // then clear any trailing old lines if the frame got shorter.
            if (previousLineCount > 1) {
                stream.write(returnPrefix + ansiEscapes.cursorUp(previousLineCount - 1));
            } else if (returnPrefix) {
                stream.write(returnPrefix);
            }

            stream.write(renderWithClearedLineEnds(output));

            if (nextLineCount < previousLineCount) {
                stream.write(ansiEscapes.eraseDown);
            }

            // Position cursor after rendering content
            const cursorSuffix = buildCursorSuffix(visibleLineCount, cursorPosition);
            stream.write(cursorSuffix);
            cursorShown = !!cursorSuffix;
        } else {
            // Only cursor position changed; output is identical — avoid full repaint
            const sequence = buildCursorOnlySequence({
                cursorWasShown: cursorShown,
                previousLineCount,
                previousCursorPosition,
                visibleLineCount,
                cursorPosition,
            });
            stream.write(sequence);
            cursorShown = !!cursorPosition;
        }

        previousOutput = output;
        previousLineCount = nextLineCount;
        previousCursorPosition = cursorPosition;

        return true;
    };

    render.clear = () => {
        // Return cursor to bottom before erasing (it may be at cursorPosition)
        const returnPrefix = buildReturnToBottomPrefix(cursorShown, previousLineCount, previousCursorPosition);
        stream.write(returnPrefix + ansiEscapes.eraseLines(previousLineCount));
        previousOutput = '';
        previousLineCount = 0;
        cursorShown = false;
        previousCursorPosition = undefined;
    };

    render.done = () => {
        previousOutput = '';
        previousLineCount = 0;
        cursorShown = false;
        previousCursorPosition = undefined;
        if (!showCursor) {
            cliCursor.show();
            hasHiddenCursor = false;
        }
    };

    // Sync internal state to match output that was written directly to the stream
    // (bypassing this render function), so subsequent renders skip unchanged content.
    render.sync = (str) => {
        previousOutput = str + '\n';
        previousLineCount = (str + '\n').split('\n').length;
        previousCursorPosition = cursorPosition;
        cursorShown = false;
    };

    // Store the desired cursor position; isCursorDirty() will return true until
    // the next render applies it.
    render.setCursorPosition = (position) => {
        cursorPosition = position;
    };

    // Returns true if cursor position has changed since the last render.
    render.isCursorDirty = () => {
        return cursorPositionChanged(cursorPosition, previousCursorPosition);
    };

    // Predicts whether render(str) would write to the stream (used to gate
    // synchronization escape sequences around the actual write).
    render.willRender = (str) => {
        const output = str + '\n';
        return output !== previousOutput || cursorPositionChanged(cursorPosition, previousCursorPosition);
    };

    return render;
};

const logUpdate = { create };
export default logUpdate;
