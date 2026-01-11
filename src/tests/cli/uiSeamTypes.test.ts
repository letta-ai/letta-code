import { describe, expect, test } from "bun:test";
import type { ComponentType, ReactNode } from "react";

import type { InputProps } from "../../cli/components/InputRich";

type AppType = typeof import("../../cli/App").default;
type AppProps = Parameters<AppType>[0];
type Ui = NonNullable<AppProps["ui"]>;

type Assert<T extends true> = T;

type UiInput = NonNullable<Ui["Input"]>;
type _InputPropTypeIsExposed = Assert<
  UiInput extends ComponentType<InputProps> ? true : false
>;

type RenderStaticItem = NonNullable<Ui["renderStaticItem"]>;
type StaticArgs = Parameters<RenderStaticItem>[0];
type StaticFallback = Parameters<RenderStaticItem>[1];
type _StaticFallbackSignature = Assert<
  StaticFallback extends () => ReactNode ? true : false
>;
type _StaticReturnType = Assert<
  ReturnType<RenderStaticItem> extends ReactNode ? true : false
>;
type _StaticArgsShape = Assert<
  StaticArgs extends {
    item: { kind: string };
    index: number;
    columns: number;
    precomputedDiffs: Map<string, unknown>;
    lastPlanFilePath: string | null;
  }
    ? true
    : false
>;

type RenderLiveItem = NonNullable<Ui["renderLiveItem"]>;
type LiveArgs = Parameters<RenderLiveItem>[0];
type LiveFallback = Parameters<RenderLiveItem>[1];
type _LiveFallbackSignature = Assert<
  LiveFallback extends () => ReactNode ? true : false
>;
type _LiveReturnType = Assert<
  ReturnType<RenderLiveItem> extends ReactNode ? true : false
>;
type _LiveArgsShape = Assert<
  LiveArgs extends {
    item: { kind: string };
    columns: number;
    pendingIds: Set<string>;
    queuedIds: Set<string>;
    precomputedDiffs: Map<string, unknown>;
    lastPlanFilePath: string | null;
  }
    ? true
    : false
>;

type RenderOverlay = NonNullable<Ui["renderOverlay"]>;
type OverlayArgs = Parameters<RenderOverlay>[0];
type OverlayFallback = Parameters<RenderOverlay>[1];
type _OverlayFallbackSignature = Assert<
  OverlayFallback extends () => ReactNode ? true : false
>;
type _OverlayReturnType = Assert<
  ReturnType<RenderOverlay> extends ReactNode ? true : false
>;
type _OverlayArgsShape = Assert<
  OverlayArgs extends {
    activeOverlay: unknown;
    closeOverlay: () => void;
    agentId: string;
    pendingApprovals: unknown[];
    currentApprovalIndex: number;
    onSelectModel: (modelId: string) => Promise<void>;
    onQuestionSubmit: (answers: Record<string, string>) => Promise<void>;
  }
    ? true
    : false
>;

type OpenOverlayParam = Parameters<OverlayArgs["openOverlay"]>[0];
type _OpenOverlayAcceptsModel = Assert<
  "model" extends OpenOverlayParam ? true : false
>;

function consume<T>(_value: T): void {}

describe("cli ui seam types", () => {
  test("a sample ui override object typechecks", () => {
    const CustomInput: ComponentType<InputProps> = () => null;

    const ui: Ui = {
      Input: CustomInput,
      renderStaticItem: (args, next) => {
        consume(args);
        return next();
      },
      renderLiveItem: (args, next) => {
        consume(args);
        return next();
      },
      renderOverlay: (args, next) => {
        consume(args);
        return next();
      },
    };

    expect(ui.Input).toBe(CustomInput);
  });
});
