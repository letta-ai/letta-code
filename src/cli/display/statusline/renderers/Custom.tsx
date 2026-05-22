import type {
  StatuslineRenderer,
  StatuslineRendererOutput,
} from "@/cli/display/statusline/types";

export function renderCustomStatusline(): StatuslineRendererOutput | null {
  return null;
}

export const customStatuslineRenderer: StatuslineRenderer = {
  id: "custom",
  label: "Custom",
  description:
    "Empty placeholder for a project or user statusline.tsx renderer.",
  render: renderCustomStatusline,
};
