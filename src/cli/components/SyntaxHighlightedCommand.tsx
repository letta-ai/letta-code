import type {
  Element,
  ElementContent,
  Text as HastText,
  Root,
  RootContent,
} from "hast";
import { Box } from "ink";
import { common, createLowlight } from "lowlight";
import type { ReactNode } from "react";
import { Fragment, memo } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

const lowlight = createLowlight(common);
const BASH_LANGUAGE = "bash";
const FIRST_LINE_PREFIX = "$ ";

type Props = {
  command: string;
  showPrompt?: boolean;
  prefix?: string;
  suffix?: string;
};

type ShellSyntaxPalette = typeof colors.shellSyntax;

function colorForClassName(
  className: string,
  palette: ShellSyntaxPalette,
): string {
  if (className === "hljs-comment") return palette.comment;
  if (className === "hljs-keyword") return palette.keyword;
  if (className === "hljs-string" || className === "hljs-regexp") {
    return palette.string;
  }
  if (className === "hljs-number") return palette.number;
  if (className === "hljs-literal") return palette.literal;
  if (
    className === "hljs-built_in" ||
    className === "hljs-builtin-name" ||
    className === "hljs-type"
  ) {
    return palette.builtIn;
  }
  if (
    className === "hljs-variable" ||
    className === "hljs-template-variable" ||
    className === "hljs-params"
  ) {
    return palette.variable;
  }
  if (className === "hljs-title" || className === "hljs-function") {
    return palette.title;
  }
  if (className === "hljs-attr" || className === "hljs-attribute") {
    return palette.attr;
  }
  if (className === "hljs-meta") return palette.meta;
  if (
    className === "hljs-operator" ||
    className === "hljs-punctuation" ||
    className === "hljs-symbol"
  ) {
    return palette.operator;
  }
  if (className === "hljs-subst") return palette.substitution;
  return palette.text;
}

function getNodeSignature(node: RootContent | ElementContent): string {
  if (node.type === "text") {
    return `text:${node.value}`;
  }

  if (node.type !== "element") {
    return node.type;
  }

  const nodeClasses =
    (node.properties?.className as string[] | undefined) ?? [];
  const childSignatures = node.children
    ?.map((child: ElementContent) => getNodeSignature(child))
    .join("|");
  return `element:${node.tagName}:${nodeClasses.join(".")}:${childSignatures ?? ""}`;
}

function renderChildren(
  children: ReadonlyArray<RootContent | ElementContent> | undefined,
  palette: ShellSyntaxPalette,
  inheritedColor?: string,
): ReactNode {
  if (!children?.length) {
    return null;
  }

  const seenSignatures = new Map<string, number>();

  return (
    <>
      {children.map((child) => {
        const signature = getNodeSignature(child);
        const duplicateCount = seenSignatures.get(signature) ?? 0;
        seenSignatures.set(signature, duplicateCount + 1);
        const key = `${signature}:${duplicateCount}`;
        return (
          <Fragment key={key}>
            {renderHighlightedNode(child, palette, inheritedColor)}
          </Fragment>
        );
      })}
    </>
  );
}

function renderHighlightedNode(
  node: Root | Element | HastText | RootContent,
  palette: ShellSyntaxPalette,
  inheritedColor?: string,
): ReactNode {
  if (node.type === "text") {
    return <Text color={inheritedColor ?? palette.text}>{node.value}</Text>;
  }

  if (node.type === "element") {
    const nodeClasses =
      (node.properties?.className as string[] | undefined) ?? [];
    const highlightClass = [...nodeClasses]
      .reverse()
      .find((name) => name.startsWith("hljs-"));
    const nodeColor = highlightClass
      ? colorForClassName(highlightClass, palette)
      : inheritedColor;

    return renderChildren(node.children, palette, nodeColor);
  }

  if (node.type === "root") {
    return renderChildren(node.children, palette, inheritedColor);
  }

  return null;
}

function renderLine(line: string, palette: ShellSyntaxPalette): ReactNode {
  try {
    const highlighted = lowlight.highlight(BASH_LANGUAGE, line);
    return renderHighlightedNode(highlighted, palette);
  } catch {
    return line;
  }
}

export const SyntaxHighlightedCommand = memo(
  ({ command, showPrompt = true, prefix, suffix }: Props) => {
    const palette = colors.shellSyntax;
    const lines = command.split("\n");

    return (
      <Box flexDirection="column">
        {lines.map((line, index) => (
          <Box key={`${index}:${line}`}>
            {showPrompt ? (
              <Text color={palette.prompt}>
                {index === 0 ? FIRST_LINE_PREFIX : "  "}
              </Text>
            ) : null}
            <Text color={palette.text}>
              {index === 0 && prefix ? prefix : null}
              {renderLine(line, palette)}
              {index === lines.length - 1 && suffix ? suffix : null}
            </Text>
          </Box>
        ))}
      </Box>
    );
  },
);

SyntaxHighlightedCommand.displayName = "SyntaxHighlightedCommand";
