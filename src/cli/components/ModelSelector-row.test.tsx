import { expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { ModelListRow, type UiModel } from "@/cli/components/ModelSelector";

const longDescriptionModel: UiModel = {
  id: "minimax-m3",
  handle: "minimax/MiniMax-M3",
  label: "MiniMax M3",
  description:
    "MiniMax's frontier M-series model for agentic reasoning, tool use, coding, multimodal chat input, and long-context tasks",
};

type ElementProps = {
  children?: ReactNode;
  wrap?: string;
  flexDirection?: string;
};

function asElement(node: ReactNode): ReactElement<ElementProps> {
  if (!isValidElement<ElementProps>(node)) {
    throw new Error("Expected a React element");
  }
  return node;
}

function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join("");
  }
  if (isValidElement<ElementProps>(node)) {
    return collectText(node.props.children);
  }
  return "";
}

test("ModelListRow renders content inside one truncating text node", () => {
  const row = asElement(
    ModelListRow({
      model: longDescriptionModel,
      isSelected: false,
      isCurrent: false,
      showLock: false,
    }),
  );

  expect(row.props.flexDirection).toBe("row");

  const rowText = asElement(row.props.children);
  expect(rowText.props.wrap).toBe("truncate-end");

  const text = collectText(rowText);
  expect(text).toContain("MiniMax M3 ·");
  expect(text).toContain("long-context tasks");
  expect(text).not.toContain("\n");
});
