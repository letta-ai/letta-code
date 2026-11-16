> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Send messages to a running agent

> Send follow-up messages and images to one Agent SDK session with streaming input, read each response, and interrupt a response to redirect Claude.

Streaming input keeps an Agent SDK session open so your application can send it more than one message while it runs. You can also attach images to a message and stop a response partway through to redirect Claude.

> [!NOTE]
>
> Streaming input covers the messages you send. To show Claude's response as it's generated, see [Stream responses in real-time](https://code.claude.com/docs/en/agent-sdk/streaming-output.md).

## Choose single-shot or streaming input

Choose streaming input for an application that holds a conversation with Claude, such as a chat interface. Use streaming input to attach images to a message, interrupt a response, or [switch the model or permission mode](https://code.claude.com/docs/en/agent-sdk/configuration.md#change-configuration-mid-session) while the session runs.

A single-shot call passes one prompt string to `query()`. The call ends after Claude answers it. Single-shot fits a single task, such as a serverless function. To follow up after that call ends, start a new call that resumes the session. For more information, see [Continue, resume, and fork](https://code.claude.com/docs/en/agent-sdk/sessions.md#continue-resume-and-fork).

## Send more than one message to a session

* **TypeScript**: write an [async generator](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function%2A) that yields [`SDKUserMessage`](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusermessage) objects, and pass it as the `prompt` of `query()`. Make the generator wait between yields for the next message from your user.
* **Python**: open a `ClaudeSDKClient` and pass each message to `client.query()`. Pass a string for a text message. To attach an image, pass an [async generator](https://docs.python.org/3/glossary.html#term-asynchronous-generator) that yields user message dicts.

To have Claude answer each message in its own response, wait for the previous response's [result message](#read-each-response) before you send the next one:

* **TypeScript**: have your generator await a promise. Resolve it in your `for await` loop over `query()` when the result message arrives.
* **Python**: call `client.query()` with the next message after your [`receive_response()`](https://code.claude.com/docs/en/agent-sdk/python#claudesdkclient) loop ends.

> [!NOTE]
>
> A message you send during tool calls reaches Claude after those tool calls finish. Claude then answers it and your earlier message in one response. If the turn ends first, Claude starts a new turn for it. For details, see [Turns and budget](https://code.claude.com/docs/en/agent-sdk/agent-loop.md#turns-and-budget).

### Send a follow-up with an image

This example sends a text question, then a follow-up with an image, and prints Claude's response to each. Before you run it, save a PNG image as `diagram.png` in your working directory:

```typescript TypeScript theme={null}
import { readFile } from "node:fs/promises";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

let firstResponseDone!: () => void;
const firstResponseFinished = new Promise<void>((resolve) => {
  firstResponseDone = resolve;
});

async function* messages(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: "Explain in two sentences what a message queue does.",
    },
    parent_tool_use_id: null,
  };

  await firstResponseFinished;

  const image = await readFile("diagram.png");
  yield {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: "Describe this image in one sentence." },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: image.toString("base64"),
          },
        },
      ],
    },
    parent_tool_use_id: null,
  };
}

let responses = 0;
for await (const message of query({ prompt: messages() })) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text") {
        console.log(block.text);
      }
    }
  } else if (message.type === "result") {
    responses += 1;
    console.log(`Response ${responses} finished: ${message.subtype}`);
    if (responses === 1) {
      firstResponseDone();
    }
  }
}
```

```python Python theme={null}
import asyncio
import base64
from pathlib import Path

from claude_agent_sdk import AssistantMessage, ClaudeSDKClient, ResultMessage, TextBlock


async def image_message():
    image_data = base64.b64encode(Path("diagram.png").read_bytes()).decode()
    yield {
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this image in one sentence."},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": image_data,
                    },
                },
            ],
        },
    }


async def main():
    async with ClaudeSDKClient() as client:
        await client.query("Explain in two sentences what a message queue does.")
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        print(block.text)
            elif isinstance(message, ResultMessage):
                print(f"Response 1 finished: {message.subtype}")

        await client.query(image_message())
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        print(block.text)
            elif isinstance(message, ResultMessage):
                print(f"Response 2 finished: {message.subtype}")


asyncio.run(main())
```

When you run either version, the example prints `Response 1 finished: success` and `Response 2 finished: success`.

If Claude didn't see your image, see [Image could not be processed](https://code.claude.com/docs/en/agent-sdk/troubleshooting.md#image-could-not-be-processed).

### Feed messages from a chat interface in TypeScript

Feed your user's messages to your prompt generator through a queue:

* **`pushMessage()`**: your interface's input handler calls this for each message the user sends.
* **`closeInput()`**: the handler calls this when the user closes the chat.
* **`userMessages()`**: the generator you pass as the `prompt` of `query()`.

`pushMessage()` adds each message to an array, and the generator reads from that array. When the array is empty, the generator waits until a message arrives or the chat closes:

```typescript theme={null}
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const pending: string[] = [];
let wake: (() => void) | null = null;
let closed = false;

// The interface's input handler calls this with each message the user sends.
function pushMessage(text: string): void {
  pending.push(text);
  wake?.();
}

// The interface calls this when the user closes the chat.
function closeInput(): void {
  closed = true;
  wake?.();
}

async function* userMessages(): AsyncGenerator<SDKUserMessage> {
  while (true) {
    const text = pending.shift();
    if (text !== undefined) {
      yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    } else if (closed) {
      return;
    } else {
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  }
}
```

Messages you push during a response can share one response. To choose when Claude reads a message you push during a response, set the message's [`priority`](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusermessage) field.

## Read each response

Claude ends each response with a result message.

* **TypeScript**: the `for await` loop over `query()` yields each response's messages in order. The loop ends after the last response's result message, once your generator has returned. To match a result to the messages it answers, set a `uuid` on each message you send, and read the result's [`user_message_uuids`](https://code.claude.com/docs/en/agent-sdk/typescript#user_message_uuids).
* **Python**: start a `receive_response()` loop for each response, because each loop stops after the next [`ResultMessage`](https://code.claude.com/docs/en/agent-sdk/python#resultmessage). The client keeps the conversation's context from one message to the next. For more information, see [Automatic session management](https://code.claude.com/docs/en/agent-sdk/sessions.md#automatic-session-management).

The result message's `subtype` field reports how the response ended, such as `success` or `error_during_execution`.

If the last response ends in an error result:

* **TypeScript**: the loop over `query()` yields that result and then throws. Wrap the loop in `try`/`catch` to handle the exception. To keep the conversation going after the throw, start a new `query()` call that [resumes the session](https://code.claude.com/docs/en/agent-sdk/sessions.md#continue-resume-and-fork). While your generator still has messages to send, an error result for an earlier response doesn't throw.
* **Python**: `receive_response()` on a `ClaudeSDKClient` yields the error result without raising.

For what each result subtype means, see [Handle the result](https://code.claude.com/docs/en/agent-sdk/agent-loop.md#handle-the-result).

## Interrupt Claude's response

To stop a response partway through and keep the session open, call `interrupt()` on the object that runs the session:

* **TypeScript**: pass an async generator as `prompt`, save the [`Query` object](https://code.claude.com/docs/en/agent-sdk/typescript#query-object) returned by `query()`, and call `interrupt()` on it.
* **Python**: call `interrupt()` on the `ClaudeSDKClient`. If a `receive_response()` loop is reading the response, that loop ends at the interrupted response's `ResultMessage`. Send your next message after that result arrives.

When you call `interrupt()` during a response, that response ends with an `error_during_execution` result. Messages you sent before the interrupt that Claude hadn't read yet still reach Claude once the interrupted response ends. For what the TypeScript loop does when the last response is an error result, see [Read each response](#read-each-response).

This example asks Claude for a long essay. The example calls `interrupt()` three seconds after the session starts, then sends a second message to the same session once the interrupted response ends:

```typescript TypeScript theme={null}
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

let firstResponseDone!: () => void;
const firstResponseFinished = new Promise<void>((resolve) => {
  firstResponseDone = resolve;
});

async function* messages(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: "Write a 2,000-word essay on the history of the printing press.",
    },
    parent_tool_use_id: null,
  };

  await firstResponseFinished;

  yield {
    type: "user",
    message: {
      role: "user",
      content: "In one sentence, what is a prime number?",
    },
    parent_tool_use_id: null,
  };
}

const conversation = query({ prompt: messages() });

let responses = 0;
for await (const message of conversation) {
  if (message.type === "system" && message.subtype === "init" && responses === 0) {
    setTimeout(async () => {
      await conversation.interrupt();
      console.log("Interrupt sent");
    }, 3000);
  } else if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text") {
        console.log(block.text);
      }
    }
  } else if (message.type === "result") {
    responses += 1;
    console.log(`Response ${responses} finished: ${message.subtype}`);
    if (responses === 1) {
      firstResponseDone();
    }
  }
}
```

```python Python theme={null}
import asyncio

from claude_agent_sdk import AssistantMessage, ClaudeSDKClient, ResultMessage, TextBlock


async def main():
    async with ClaudeSDKClient() as client:
        await client.query("Write a 2,000-word essay on the history of the printing press.")
        await asyncio.sleep(3)
        await client.interrupt()
        print("Interrupt sent")
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        print(block.text)
            elif isinstance(message, ResultMessage):
                print(f"Response 1 finished: {message.subtype}")

        await client.query("In one sentence, what is a prime number?")
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        print(block.text)
            elif isinstance(message, ResultMessage):
                print(f"Response 2 finished: {message.subtype}")


asyncio.run(main())
```

When you run either version, the first response stops partway through the essay, and the example prints `Response 1 finished: error_during_execution`. Claude then answers the second message. The output ends with `Response 2 finished: success`.

## Next steps

* [Stream responses in real-time](https://code.claude.com/docs/en/agent-sdk/streaming-output.md): show text and tool calls as Claude generates them
* [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input.md): answer Claude's permission requests and clarifying questions
* [Change configuration mid-session](https://code.claude.com/docs/en/agent-sdk/configuration.md#change-configuration-mid-session): switch the model or permission mode while the session runs
* [`Query` object](https://code.claude.com/docs/en/agent-sdk/typescript#query-object) in TypeScript and [`ClaudeSDKClient`](https://code.claude.com/docs/en/agent-sdk/python#claudesdkclient) in Python: the methods that send messages to a running session or control it
* [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md): resume, continue, or fork a conversation
