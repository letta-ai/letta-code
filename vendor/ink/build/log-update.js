import ansiEscapes from 'ansi-escapes';
import cliCursor from 'cli-cursor';
import stringWidth from 'string-width';

const create = (stream, { showCursor = false } = {}) => {
    let previousLineCount = 0;
    let previousOutput = '';
    let hasHiddenCursor = false;

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
        if (output === previousOutput) {
            return;
        }

        // Keep existing line-count semantics used by Ink's bundled log-update.
        const nextLineCount = output.split('\n').length;

        // Avoid eraseLines() pre-clear flashes by repainting in place:
        // move to start of previous frame, rewrite each line while erasing EOL,
        // then clear any trailing old lines if the frame got shorter.
        if (previousLineCount > 1) {
            stream.write(ansiEscapes.cursorUp(previousLineCount - 1));
        }
        stream.write(renderWithClearedLineEnds(output));
        if (nextLineCount < previousLineCount) {
            stream.write(ansiEscapes.eraseDown);
        }

        previousOutput = output;
        previousLineCount = nextLineCount;
    };

    render.clear = () => {
        stream.write(ansiEscapes.eraseLines(previousLineCount));
        previousOutput = '';
        previousLineCount = 0;
    };

    render.done = () => {
        previousOutput = '';
        previousLineCount = 0;
        if (!showCursor) {
            cliCursor.show();
            hasHiddenCursor = false;
        }
    };

    return render;
};

const logUpdate = { create };
export default logUpdate;
