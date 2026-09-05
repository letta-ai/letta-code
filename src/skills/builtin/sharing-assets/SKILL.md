---
name: sharing-assets
description: Publishes images and videos as shareable links and embeds them in replies to the user. Use when sharing generated images, screenshots, GIFs, recordings, demos, or other media, or when the user asks to see, download, or get a link to an image or video. Requires a user logged in to Letta Cloud and a managed Cloud sandbox; not available for local-only agents. Published links are public and temporary.
---

# Sharing assets

Share existing images and videos through Letta's managed artifact publisher.
For capturing and inspecting UI demonstrations, load `demonstrating-your-work`
first; this skill handles delivery, not creation.

## Requirements and privacy

- Require a user logged in to Letta Cloud and run the publisher in the managed
  Cloud sandbox containing the file. Local-only agents are unsupported. A normal
  user API key on a local computer is not sufficient: upload authorization
  requires the sandbox-generated key.
- Publish only PNG, JPEG, WebP, GIF, MP4, or WebM files, up to 250 MiB each.
  HTML and other file types are not supported yet.
- Treat links as **public to anyone with the URL**, without viewer login. Check
  the asset for secrets and private content before uploading; ask before making
  sensitive content public. For private delivery or unsupported formats, use
  `transferring-files-with-the-user` in the Cloud sandbox instead.
- Treat publication as temporary: storage is configured to delete artifacts
  after 30 days. Do not promise permanent hosting or immediate revocation of
  publicly cached copies.

## Publish

Use the existing managed helper; do not request storage credentials or substitute
another public host. Its absolute path is intentional: `$HOME` can differ in
managed sandboxes.

```bash
LETTA_API_KEY="$LETTA_API_KEY" \
  /root/.letta/cloud-skills/demonstrating-your-work/scripts/publish-artifact.sh \
  /root/downloads/demo.mp4
```

Keep the runtime-provided `LETTA_BASE_URL`, `AGENT_ID`, and `LETTA_API_KEY`.
The helper checks the file, requests a short-lived upload policy, uploads it,
verifies the public size/type/cache metadata, and prints only the verified URL.
If `CONVERSATION_ID` is the virtual value `default`, set `CONVERSATION_ID=` on
the command to omit that optional association; keep real conversation IDs.

If the helper is missing, report that publishing requires a provisioned Cloud
sandbox. If authentication or authorization fails, report it; do not switch
credentials or hosts to bypass the restriction. Never invent a successful URL.

## Share with the user

Use the exact returned URL, not a local path, base64, or a `sandbox:` URL.
In Letta chat and Desktop, use Markdown image syntax for **both images and
videos**:

```markdown
![Screenshot description](https://chat.letta.com/artifacts/<returned-image-id>)
![Video description](https://chat.letta.com/artifacts/<returned-video-id>.mp4)
```

Video URLs must end in `.mp4` or `.webm` to render an inline player. Do not append
an extension to a returned URL yourself. A normal `[Download](url)` link gives
the user a separate open/download link; raw HTML `<video>` is not supported.
Verify rendering when the UI is available; otherwise distinguish successful
upload verification from untested rendering.

For GitHub, link a poster image to the video: `[![Demo](poster-url)](video-url)`.
For Slack, send the public image/poster URL and video URL through `MessageChannel`.
