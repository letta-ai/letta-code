# Contributing to Letta Code

## Fork the repo

Fork the repository on GitHub by [clicking this link](https://github.com/letta-ai/letta-code/fork), then clone your fork:

```bash
git clone https://github.com/your-username/letta-code.git
cd letta-code
```

## Installing from source

Requirements:
* [Bun](https://bun.com/docs/installation)

### Installing Bun

Bun can be installed via the official installer or via npm:

**Option 1: Official installer (recommended)**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Option 2: Via npm**
```bash
npm install -g bun
```

Verify installation:
```bash
bun --version
```

### Run directly from source (dev workflow)
```bash
# install deps
bun install

# run the CLI from TypeScript sources (pick up changes immediately)
bun run dev
bun run dev -- -p "Hello world"  # example with args
```

### Build + link the standalone binary
```bash
# build bin/letta (includes prompts + schemas)
bun run build

# expose the binary globally (adjust to your preference)
bun link

# now you can run the compiled CLI
letta
```

Whenever you change source files, rerun `bun run build` before using the linked `letta` binary so it picks up your edits.
