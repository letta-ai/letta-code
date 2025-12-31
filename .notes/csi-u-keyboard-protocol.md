# CSI u Keyboard Protocol Support

## Background

iTerm2 3.5+ (and other modern terminals like Kitty, Ghostty, WezTerm) send keyboard input using the CSI u (aka "fixterms" or "libtermkey") encoding format instead of traditional escape sequences.

**Discovery**: A user reported Escape and Shift+Tab not working in iTerm2. We discovered they were on iTerm2 3.6.5 while our working setup used 3.4.19. The newer version sends CSI u encoded keys by default.

## CSI u Format

```
ESC [ keycode ; modifier u
ESC [ keycode ; modifier : event u   (with event type)
```

### Keycodes
| Key       | Keycode |
|-----------|---------|
| Tab       | 9       |
| Return    | 13      |
| Escape    | 27      |
| Backspace | 127     |
| Letters   | ASCII (a=97, z=122, A=65, Z=90) |

### Modifier Bits
The modifier value in CSI u is `(bits + 1)`:
- Shift: bit 0 (value 1) → modifier = 2
- Alt/Meta: bit 1 (value 2) → modifier = 3
- Ctrl: bit 2 (value 4) → modifier = 5
- Combinations add up: Ctrl+Shift = bits 0+2 = 5 → modifier = 6

### Event Types
- 1 = key press
- 2 = key repeat
- 3 = key release (must be ignored to avoid double-firing)

### Examples
| Key Combination | CSI u Sequence |
|-----------------|----------------|
| Escape          | `ESC[27u`      |
| Shift+Tab       | `ESC[9;2u`     |
| Ctrl+C          | `ESC[99;5u`    |
| Shift+Enter     | `ESC[13;2u`    |
| Ctrl+C release  | `ESC[99;5:3u`  |

## The Problem

Ink's `parseKeypress` (from enquirer) doesn't understand CSI u format. When iTerm2 3.5+ sends `ESC[9;2u` for Shift+Tab:

```javascript
const keypress = parseKeypress(data);
// Returns: { name: '', ctrl: false, shift: false, ... }
```

This caused Escape and Shift+Tab (and other keys) to not work.

## Prior Workaround

Before this fix, we handled CSI u sequences in PasteAwareTextInput's raw stdin handler:

```javascript
stdin.on("data", (payload) => {
  // Intercept ESC[99;5u and convert to 0x03
  if (sequence === "\x1b[99;5u") {
    internal_eventEmitter.emit("input", "\x03");
    return;
  }
  // ... similar for Ctrl+V, Shift+Enter, etc.
});
```

**Limitation**: Raw handlers only work when PasteAwareTextInput is focused. Menus like `/memory` don't have focus, so Ctrl+C didn't work there.

## The Fix

### 1. CSI u Fallback in use-input.js

Added CSI u parsing as a fallback in `vendor/ink/build/hooks/use-input.js`:

```javascript
let keypress = parseKeypress(data);

// CSI u fallback: if parseKeypress didn't recognize it
if (!keypress.name && typeof data === 'string') {
  const csiUMatch = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?u$/);
  if (csiUMatch) {
    const keycode = parseInt(csiUMatch[1], 10);
    const modifier = parseInt(csiUMatch[2] || '1', 10) - 1;
    const event = csiUMatch[3] ? parseInt(csiUMatch[3], 10) : 1;
    
    // Ignore key release events (event=3)
    if (event === 3) return;
    
    // Map keycodes to names
    const csiUKeyMap = { 9: 'tab', 13: 'return', 27: 'escape', 127: 'backspace' };
    let name = csiUKeyMap[keycode] || '';
    
    // Handle letter keycodes (a-z, A-Z)
    if (!name && keycode >= 97 && keycode <= 122) {
      name = String.fromCharCode(keycode);
    }
    
    if (name) {
      keypress = {
        name,
        ctrl: !!(modifier & 4),
        meta: !!(modifier & 10),
        shift: !!(modifier & 1),
        // ...
      };
    }
  }
}
```

### 2. Remove Redundant Raw Handlers

After adding CSI u fallback, we had **double-firing**: both the raw handler AND the useInput handler processed the same sequence.

**Removed from PasteAwareTextInput.tsx**:
- Ctrl+C handler (`ESC[99;5u` → `0x03` conversion)
- Ctrl+V handler (`ESC[118;5u` clipboard handling)
- Modifier+Enter handler (`ESC[13;Nu` newline insertion)

**Kept**:
- Option+Enter (`ESC + CR`) - not CSI u format
- VS Code keybinding style (`\\r`) - not CSI u format
- Arrow keys with event types - different format, still needed

## Testing Matrix

| Terminal    | Version | Escape | Shift+Tab | Ctrl+C (menu) | Ctrl+C (main) | Shift+Enter |
|-------------|---------|--------|-----------|---------------|---------------|-------------|
| iTerm2      | 3.4.19  | ✓      | ✓         | ✓             | ✓             | ✓           |
| iTerm2      | 3.6.5   | ✓      | ✓         | ✓             | ✓             | ✓           |
| Kitty       | -       | ✓      | ✓         | ✓             | ✓             | ✓           |
| Ghostty     | -       | ✓      | ✓         | ✓             | ✓             | ✓           |
| WezTerm     | -       | ✓      | ✓         | ✓             | ✓             | ✓           |
| VS Code     | -       | ✓      | ✓         | ✓             | ✓             | ✓           |
| Mac Terminal| -       | ✓      | ✓         | ✓             | ✓             | (no support)|

## Debug Environment Variables

- `LETTA_DEBUG_KEYS=1` - Log raw keypresses and parsed results in use-input.js
- `LETTA_DEBUG_INPUT=1` - Log raw stdin bytes in PasteAwareTextInput
- `LETTA_DISABLE_KITTY=1` - Skip enabling Kitty keyboard protocol (for debugging)

## Key Insight

Raw stdin handlers were a **workaround** for Ink not understanding CSI u. The proper fix is teaching Ink to parse CSI u natively:

1. Works everywhere (focused and unfocused contexts)
2. Single code path for all key handling
3. No double-firing issues
4. Easier to maintain

## References

- [Kitty Keyboard Protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)
- [fixterms spec](http://www.leonerd.org.uk/hacks/fixterms/)
- Gemini CLI's KeypressContext.tsx - comprehensive CSI u parsing example
