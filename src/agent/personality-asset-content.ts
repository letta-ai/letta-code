import type { PersonalityAssetId } from "./personality-presets";

declare const __TUTOR_PROFILE_PICTURE_BASE64__: string | undefined;

interface BunFile {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface BunRuntime {
  file(path: string | URL): BunFile;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

async function tutorProfilePictureBase64(): Promise<string> {
  if (typeof __TUTOR_PROFILE_PICTURE_BASE64__ !== "undefined") {
    return __TUTOR_PROFILE_PICTURE_BASE64__;
  }

  const bun = (globalThis as { Bun?: BunRuntime }).Bun;
  if (!bun) {
    throw new Error("Bundled personality asset is unavailable");
  }
  const asset = new URL("../../assets/tutor-profile.png", import.meta.url);
  return encodeBase64(new Uint8Array(await bun.file(asset).arrayBuffer()));
}

export async function getPersonalityAssetBase64(
  assetId: PersonalityAssetId,
): Promise<string> {
  switch (assetId) {
    case "tutor-profile":
      return tutorProfilePictureBase64();
  }
}
