import { memo, useMemo } from "react";
import type { ModDialog, ModEngine } from "@/mods/mod-engine";
import { InlineQuestionApproval } from "./InlineQuestionApproval";

type Props = {
  dialog: ModDialog;
  engine: ModEngine;
};

/**
 * Renders a mod-driven blocking dialog (letta.ui.select) through the same
 * InlineQuestionApproval component as the built-in AskUserQuestion tool, so the
 * UX is identical. Normalizes the mod-facing ModDialogQuestion shape (optional
 * options/multiSelect) to the component's required shape, and settles the
 * awaiting select() call via engine.resolveDialog. Only mounted when the dialog
 * has input focus, so it always renders focused.
 */
export const ModDialogPrompt = memo(({ dialog, engine }: Props) => {
  const questions = useMemo(
    () =>
      dialog.questions.map((question) => ({
        question: question.question,
        header: question.header,
        options: (question.options ?? []).map((option) => ({
          label: option.label,
          description: option.description ?? "",
        })),
        multiSelect: question.multiSelect ?? false,
        allowOther: question.allowOther,
      })),
    [dialog.questions],
  );

  return (
    <InlineQuestionApproval
      questions={questions}
      onSubmit={(answers) => engine.resolveDialog(dialog.id, answers)}
      onCancel={() => engine.resolveDialog(dialog.id, null)}
    />
  );
});

ModDialogPrompt.displayName = "ModDialogPrompt";
