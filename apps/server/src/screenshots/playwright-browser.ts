import type { Browser, LaunchOptions } from "playwright";

const SYSTEM_CHROME_CHANNEL = "chrome";

interface ChromiumLauncher {
  launch(options?: LaunchOptions): Promise<Browser>;
}

/**
 * Prefer Playwright's bundled Chromium, but fall back to the local Chrome channel
 * when the browser cache is absent in an operator's local environment.
 */
export async function launchChromiumWithChromeFallback(
  chromium: ChromiumLauncher,
  options: LaunchOptions = {},
): Promise<Browser> {
  try {
    return await chromium.launch(options);
  } catch (primaryErr) {
    if (options.channel || options.executablePath) throw primaryErr;
    try {
      return await chromium.launch({ ...options, channel: SYSTEM_CHROME_CHANNEL });
    } catch (fallbackErr) {
      throw new Error(
        "Unable to launch Playwright Chromium. Tried the bundled browser and the system Chrome channel.",
        {
          cause: new AggregateError([primaryErr, fallbackErr], "Playwright browser launch failed"),
        },
      );
    }
  }
}
