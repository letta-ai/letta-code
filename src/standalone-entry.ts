import "@/utils/startup-log-boundary";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

registerBunOAuthFlows();

await import("./index");
