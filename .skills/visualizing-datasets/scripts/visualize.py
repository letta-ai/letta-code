#!/usr/bin/env python3
"""
Generate an interactive HTML viewer for memory eval datasets.

Supports: reflection, placement, organization, rewrite.
Auto-detects format from dataset.jsonl keys.

Usage:
    python visualize.py <dataset.jsonl or run_dir> [--output out.html] [--case-id 4]
"""

import argparse
import html
import json
import re
import webbrowser
from pathlib import Path
from typing import Any, Dict, List, Optional


# ── Format detection ──────────────────────────────────────────────────


def detect_format(entry: Dict) -> str:
    """Detect dataset format from first entry's keys."""
    if "memory_before" in entry and "conversation" in entry:
        return "reflection"
    if "expected_diff" in entry:
        return "reflection"
    extra = entry.get("extra_vars", {})
    gt_raw = entry.get("ground_truth", "{}")
    gt = json.loads(gt_raw) if isinstance(gt_raw, str) else gt_raw
    if "rewrites" in gt:
        return "rewrite"
    if "placements" in gt:
        return "placement"
    if extra.get("difficulty"):
        return "organization"
    return "generic"


# ── Data normalization ────────────────────────────────────────────────


def load_entries(dataset_path: Path, case_id: Optional[int] = None) -> List[Dict]:
    """Load and optionally filter dataset entries."""
    entries = []
    with open(dataset_path) as f:
        for line in f:
            if line.strip():
                try:
                    e = json.loads(line)
                    if case_id is None or e.get("id") == case_id:
                        entries.append(e)
                except json.JSONDecodeError:
                    continue
    return entries


def resolve_data_file(entry: Dict, dataset_dir: Path) -> Optional[Dict]:
    """Load the companion JSON data file if referenced."""
    data_file = entry.get("extra_vars", {}).get("data_file", "")
    if not data_file:
        data_file = entry.get("metadata", {}).get("data_file", "")
    if data_file:
        path = dataset_dir / data_file
        if path.exists():
            with open(path) as f:
                return json.load(f)
    return None


# ── HTML rendering helpers ────────────────────────────────────────────


def esc(text: str) -> str:
    """HTML-escape text."""
    return html.escape(str(text))


def render_metadata_badges(entry: Dict, fmt: str) -> str:
    """Render metadata as colored badges."""
    meta = entry.get("metadata", {}) or entry.get("extra_vars", {})
    badges = []
    colors = {
        "easy": "#22c55e", "medium": "#eab308", "hard": "#f97316", "expert": "#ef4444",
        "fresh": "#93c5fd", "moderate": "#60a5fa", "mature": "#3b82f6", "messy": "#f87171",
    }
    for key in ("domain", "difficulty", "memory_maturity", "conversation_type",
                "category", "message_style", "starting_memory", "instruction_style"):
        val = meta.get(key)
        if val:
            color = colors.get(val, "#6b7280")
            badges.append(f'<span class="badge" style="background:{color}">{esc(key)}: {esc(val)}</span>')
    if meta.get("is_no_op"):
        badges.append('<span class="badge" style="background:#ef4444">NO-OP</span>')
    return " ".join(badges)


def render_memory_filesystem(memory_before: Dict[str, Dict[str, str]]) -> str:
    """Render memory_before dict as collapsible file tree."""
    parts = ['<div class="memory-section"><h3>Memory Before</h3>']
    for path in sorted(memory_before.keys()):
        data = memory_before[path]
        desc = data.get("description", "")
        value = data.get("value", "")
        tier = "system" if path.startswith("system/") else "reference" if path.startswith("reference/") else "user"
        parts.append(f'''
        <details class="memory-file {tier}">
            <summary>
                <span class="file-path">{esc(path)}</span>
                <span class="file-desc">{esc(desc)}</span>
                <span class="file-size">{len(value)} chars</span>
            </summary>
            <pre class="file-content">{esc(value)}</pre>
        </details>''')
    parts.append("</div>")
    return "\n".join(parts)


def render_memory_blocks(blocks: List[Dict[str, str]]) -> str:
    """Render memory_blocks list as collapsible blocks."""
    parts = ['<div class="memory-section"><h3>Memory Blocks</h3>']
    for block in blocks:
        label = block.get("label", "")
        desc = block.get("description", "")
        value = block.get("value", "")
        tier = "system" if label.startswith("system/") else "user" if label.startswith("user/") else "other"
        parts.append(f'''
        <details class="memory-file {tier}">
            <summary>
                <span class="file-path">{esc(label)}</span>
                <span class="file-desc">{esc(desc)}</span>
                <span class="file-size">{len(value)} chars</span>
            </summary>
            <pre class="file-content">{esc(value)}</pre>
        </details>''')
    parts.append("</div>")
    return "\n".join(parts)


def _parse_conversation_xml(xml: str) -> List[Dict[str, str]]:
    """Parse conversation XML into structured turns."""
    turns = []
    # Match user and assistant blocks
    for m in re.finditer(r"<(user|assistant)>(.*?)</\1>", xml, re.DOTALL):
        role = m.group(1)
        content = m.group(2).strip()
        if role == "assistant":
            # Extract sub-blocks
            parts = []
            for sub in re.finditer(
                r"<(thinking|text|tool_use|tool_result)[^>]*>(.*?)</\1>",
                content, re.DOTALL,
            ):
                tag = sub.group(1)
                # Grab name attribute for tool_use
                name_match = re.search(r'name="([^"]*)"', sub.group(0))
                name = name_match.group(1) if name_match else ""
                parts.append({"tag": tag, "name": name, "content": sub.group(2).strip()})
            if parts:
                turns.append({"role": "assistant", "parts": parts})
            else:
                turns.append({"role": "assistant", "parts": [{"tag": "text", "name": "", "content": content}]})
        else:
            turns.append({"role": "user", "parts": [{"tag": "text", "name": "", "content": content}]})
    return turns


def render_conversation(conversation: str) -> str:
    """Render XML conversation as styled chat bubbles."""
    turns = _parse_conversation_xml(conversation)
    parts = ['<div class="conversation"><h3>Conversation</h3>']
    for turn in turns:
        role = turn["role"]
        parts.append(f'<div class="turn turn-{role}">')
        parts.append(f'<div class="turn-role">{role}</div>')
        for p in turn["parts"]:
            tag = p["tag"]
            content = p["content"]
            if tag == "thinking":
                parts.append(f'''<details class="thinking">
                    <summary>💭 thinking</summary>
                    <pre>{esc(content)}</pre>
                </details>''')
            elif tag == "tool_use":
                name = p.get("name", "tool")
                parts.append(f'''<details class="tool-use">
                    <summary>🔧 {esc(name)}</summary>
                    <pre>{esc(content)}</pre>
                </details>''')
            elif tag == "tool_result":
                parts.append(f'''<details class="tool-result">
                    <summary>📋 tool result</summary>
                    <pre>{esc(content)}</pre>
                </details>''')
            else:
                parts.append(f'<div class="text-content">{esc(content)}</div>')
        parts.append("</div>")
    parts.append("</div>")
    return "\n".join(parts)


def render_user_message(message: str) -> str:
    """Render a single user message (for placement/org/rewrite)."""
    return f'''
    <div class="conversation"><h3>User Message</h3>
        <div class="turn turn-user">
            <div class="turn-role">user</div>
            <div class="text-content">{esc(message)}</div>
        </div>
    </div>'''


def render_expected_diff(diff: Dict) -> str:
    """Render expected_diff for reflection env."""
    parts = ['<div class="diff-section"><h3>Expected Diff</h3>']

    created = diff.get("created", [])
    modified = diff.get("modified", [])
    deleted = diff.get("deleted", [])

    if not created and not modified and not deleted:
        parts.append('<div class="diff-empty">No changes (no-op case)</div>')
    else:
        for entry in created:
            parts.append(f'''<div class="diff-entry diff-created">
                <div class="diff-header">+ CREATE {esc(entry.get('path', ''))}</div>
                <div class="diff-reason">{esc(entry.get('reason', ''))}</div>
                <div class="diff-desc">{esc(entry.get('description', ''))}</div>
                <pre class="diff-value">{esc(entry.get('value', ''))}</pre>
            </div>''')
        for entry in modified:
            parts.append(f'''<div class="diff-entry diff-modified">
                <div class="diff-header">~ MODIFY {esc(entry.get('path', ''))}</div>
                <div class="diff-reason">{esc(entry.get('reason', ''))}</div>
                <div class="diff-old"><strong>old:</strong> <pre>{esc(entry.get('old_content', ''))}</pre></div>
                <div class="diff-new"><strong>new:</strong> <pre>{esc(entry.get('new_content', ''))}</pre></div>
            </div>''')
        for entry in deleted:
            parts.append(f'''<div class="diff-entry diff-deleted">
                <div class="diff-header">- DELETE {esc(entry.get('path', ''))}</div>
                <div class="diff-reason">{esc(entry.get('reason', ''))}</div>
            </div>''')

    parts.append("</div>")
    return "\n".join(parts)


def render_ground_truth(gt_raw: Any) -> str:
    """Render ground truth for placement/org/rewrite."""
    gt = json.loads(gt_raw) if isinstance(gt_raw, str) else gt_raw
    parts = ['<div class="diff-section"><h3>Ground Truth</h3>']

    if "placements" in gt:
        for p in gt["placements"]:
            parts.append(f'''<div class="diff-entry diff-modified">
                <div class="diff-header">→ {esc(p.get('expected_file', ''))}</div>
                <div class="diff-reason">{esc(p.get('info', ''))}</div>
            </div>''')
    if "rewrites" in gt:
        for r in gt["rewrites"]:
            parts.append(f'''<div class="diff-entry diff-modified">
                <div class="diff-header">~ REWRITE {esc(r.get('file', r.get('label', '')))}</div>
                <div class="diff-reason">{esc(r.get('reason', ''))}</div>
                {f'<div class="diff-old"><strong>before:</strong> <pre>{esc(r.get("before", ""))}</pre></div>' if r.get("before") else ''}
                {f'<div class="diff-new"><strong>after:</strong> <pre>{esc(r.get("after", ""))}</pre></div>' if r.get("after") else ''}
            </div>''')
    if "preserve" in gt:
        for p in gt["preserve"]:
            label = p if isinstance(p, str) else p.get("label", p.get("file", str(p)))
            parts.append(f'<div class="diff-entry diff-preserve">PRESERVE: {esc(label)}</div>')
    if "rationale" in gt:
        parts.append(f'<div class="gt-rationale"><strong>Rationale:</strong> {esc(gt["rationale"])}</div>')

    parts.append("</div>")
    return "\n".join(parts)


# ── Full case rendering ───────────────────────────────────────────────


def render_case(entry: Dict, fmt: str, dataset_dir: Path) -> str:
    """Render a single case panel."""
    case_id = entry.get("id", "?")
    badges = render_metadata_badges(entry, fmt)

    # Memory section
    if fmt == "reflection":
        memory_html = render_memory_filesystem(entry.get("memory_before", {}))
    else:
        data = resolve_data_file(entry, dataset_dir)
        blocks = data.get("memory_blocks", []) if data else []
        memory_html = render_memory_blocks(blocks) if blocks else '<div class="memory-section"><h3>Memory</h3><em>No data file found</em></div>'

    # Conversation section
    if fmt == "reflection":
        conv_html = render_conversation(entry.get("conversation", ""))
    else:
        conv_html = render_user_message(entry.get("input", ""))

    # Ground truth section
    if fmt == "reflection":
        gt_html = render_expected_diff(entry.get("expected_diff", {}))
    else:
        gt_html = render_ground_truth(entry.get("ground_truth", "{}"))

    return f'''
    <div class="case-panel" id="case-{case_id}">
        <div class="case-header">
            <h2>Case #{case_id}</h2>
            <div class="badges">{badges}</div>
        </div>
        {memory_html}
        {conv_html}
        {gt_html}
    </div>'''


# ── Sidebar ───────────────────────────────────────────────────────────


def render_sidebar_item(entry: Dict, fmt: str) -> str:
    """Render a sidebar list item."""
    case_id = entry.get("id", "?")
    meta = entry.get("metadata", {}) or entry.get("extra_vars", {})

    label = meta.get("domain", meta.get("scenario", meta.get("category", "")))
    difficulty = meta.get("difficulty", meta.get("starting_memory", ""))
    is_no_op = meta.get("is_no_op", False)

    diff_colors = {"easy": "#22c55e", "medium": "#eab308", "hard": "#f97316", "expert": "#ef4444"}
    dot_color = diff_colors.get(difficulty, "#6b7280")

    noop_tag = ' <span class="noop-tag">NO-OP</span>' if is_no_op else ""

    return f'''<li class="sidebar-item" onclick="showCase({case_id})">
        <span class="dot" style="background:{dot_color}"></span>
        <span class="case-num">#{case_id}</span>
        <span class="case-label">{esc(label)}</span>{noop_tag}
    </li>'''


# ── CSS ───────────────────────────────────────────────────────────────

CSS = """
:root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --text-muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --yellow: #d29922; --red: #f85149; --blue: #58a6ff;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); display: flex; height: 100vh; overflow: hidden; }

/* Sidebar */
.sidebar { width: 280px; min-width: 280px; background: var(--surface); border-right: 1px solid var(--border); overflow-y: auto; padding: 16px 0; }
.sidebar h1 { font-size: 14px; color: var(--text-muted); padding: 0 16px 12px; border-bottom: 1px solid var(--border); margin-bottom: 8px; }
.sidebar ul { list-style: none; }
.sidebar-item { padding: 8px 16px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 13px; border-left: 3px solid transparent; }
.sidebar-item:hover { background: rgba(255,255,255,0.04); }
.sidebar-item.active { background: rgba(88,166,255,0.1); border-left-color: var(--accent); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.case-num { color: var(--text-muted); font-size: 12px; min-width: 24px; }
.case-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.noop-tag { font-size: 10px; background: var(--red); color: white; padding: 1px 4px; border-radius: 3px; }

/* Main content */
.main { flex: 1; overflow-y: auto; padding: 24px 32px; }
.case-panel { display: none; }
.case-panel.active { display: block; }
.case-header { margin-bottom: 20px; }
.case-header h2 { font-size: 20px; margin-bottom: 8px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; color: white; margin: 2px; }

/* Memory */
.memory-section { margin-bottom: 24px; }
.memory-section h3, .conversation h3, .diff-section h3 { font-size: 16px; color: var(--accent); margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.memory-file { margin-bottom: 4px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.memory-file summary { padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 13px; background: var(--surface); }
.memory-file summary:hover { background: rgba(255,255,255,0.04); }
.file-path { font-family: monospace; color: var(--accent); }
.file-desc { color: var(--text-muted); font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-size { color: var(--text-muted); font-size: 11px; white-space: nowrap; }
.file-content { padding: 12px; font-size: 12px; line-height: 1.5; background: var(--bg); white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; }
.memory-file.system .file-path { color: var(--blue); }
.memory-file.reference .file-path { color: var(--yellow); }
.memory-file.user .file-path { color: var(--green); }

/* Conversation */
.conversation { margin-bottom: 24px; }
.turn { margin-bottom: 12px; padding: 12px 16px; border-radius: 8px; }
.turn-user { background: rgba(88,166,255,0.08); border-left: 3px solid var(--blue); }
.turn-assistant { background: var(--surface); border-left: 3px solid var(--text-muted); }
.turn-role { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--text-muted); margin-bottom: 6px; }
.text-content { font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.thinking, .tool-use, .tool-result { margin: 6px 0; }
.thinking summary, .tool-use summary, .tool-result summary { font-size: 12px; cursor: pointer; color: var(--text-muted); padding: 4px 0; }
.thinking pre, .tool-use pre, .tool-result pre { font-size: 12px; padding: 8px; background: var(--bg); border-radius: 4px; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }

/* Diff / Ground Truth */
.diff-section { margin-bottom: 24px; }
.diff-entry { margin-bottom: 8px; border-radius: 6px; padding: 12px; }
.diff-created { background: rgba(63,185,80,0.08); border-left: 3px solid var(--green); }
.diff-modified { background: rgba(210,153,34,0.08); border-left: 3px solid var(--yellow); }
.diff-deleted { background: rgba(248,81,73,0.08); border-left: 3px solid var(--red); }
.diff-preserve { background: rgba(88,166,255,0.06); border-left: 3px solid var(--blue); padding: 8px 12px; font-size: 13px; margin-bottom: 4px; border-radius: 4px; }
.diff-empty { color: var(--text-muted); font-style: italic; padding: 12px; }
.diff-header { font-family: monospace; font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.diff-reason { font-size: 13px; color: var(--text-muted); margin-bottom: 8px; }
.diff-desc { font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
.diff-value, .diff-old pre, .diff-new pre { font-size: 12px; padding: 8px; background: var(--bg); border-radius: 4px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
.diff-old { margin-bottom: 6px; }
.diff-old strong { color: var(--red); }
.diff-new strong { color: var(--green); }
.gt-rationale { margin-top: 12px; padding: 12px; background: var(--surface); border-radius: 6px; font-size: 13px; line-height: 1.5; }
"""

# ── JS ────────────────────────────────────────────────────────────────

JS = """
function showCase(id) {
    document.querySelectorAll('.case-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
    const panel = document.getElementById('case-' + id);
    if (panel) panel.classList.add('active');
    const item = document.querySelector('[onclick="showCase(' + id + ')"]');
    if (item) item.classList.add('active');
}
// Show first case on load
document.addEventListener('DOMContentLoaded', () => {
    const first = document.querySelector('.sidebar-item');
    if (first) first.click();
});
"""


# ── Main assembly ─────────────────────────────────────────────────────


def build_html(entries: List[Dict], fmt: str, dataset_dir: Path, title: str) -> str:
    """Assemble the full HTML document."""
    sidebar_items = "\n".join(render_sidebar_item(e, fmt) for e in entries)
    case_panels = "\n".join(render_case(e, fmt, dataset_dir) for e in entries)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{esc(title)}</title>
<style>{CSS}</style>
</head>
<body>
<nav class="sidebar">
    <h1>{esc(title)} ({len(entries)} cases)</h1>
    <ul>{sidebar_items}</ul>
</nav>
<main class="main">
    {case_panels}
</main>
<script>{JS}</script>
</body>
</html>"""


def main():
    parser = argparse.ArgumentParser(description="Generate HTML viewer for eval datasets")
    parser.add_argument("path", type=Path, help="Path to dataset.jsonl or run directory")
    parser.add_argument("--output", "-o", type=Path, default=None, help="Output HTML path")
    parser.add_argument("--case-id", type=int, default=None, help="Show only this case ID")
    parser.add_argument("--no-open", action="store_true", help="Don't open in browser")
    args = parser.parse_args()

    # Resolve dataset path
    if args.path.is_dir():
        dataset_path = args.path / "dataset.jsonl"
    else:
        dataset_path = args.path

    if not dataset_path.exists():
        print(f"Error: {dataset_path} not found")
        return 1

    dataset_dir = dataset_path.parent

    # Load entries
    entries = load_entries(dataset_path, args.case_id)
    if not entries:
        print("No entries found" + (f" with id={args.case_id}" if args.case_id else ""))
        return 1

    # Detect format
    fmt = detect_format(entries[0])
    print(f"Detected format: {fmt} ({len(entries)} cases)")

    # Build title from directory name
    title = f"{fmt.title()} Dataset"
    if dataset_dir.name.startswith("run_"):
        title += f" — {dataset_dir.name}"

    # Generate HTML
    html_content = build_html(entries, fmt, dataset_dir, title)

    # Write output
    output_path = args.output or (dataset_dir / "viewer.html")
    output_path.write_text(html_content, encoding="utf-8")
    print(f"Generated: {output_path} ({len(html_content):,} bytes)")

    if not args.no_open:
        webbrowser.open(f"file://{output_path.resolve()}")

    return 0


if __name__ == "__main__":
    exit(main())
