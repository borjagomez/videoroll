import { login } from "../app/auth.js";
import { buildAppMap } from "../app/appmap.js";
import { appMapPath, storageStatePath, rel } from "../paths.js";
import { writeArtifact, slugify } from "../io.js";
import { AppMapSchema } from "../types.js";
import { log, bold, fmtCount } from "../log.js";

export interface ConnectOptions {
  product: string;
  profile: string;
  username?: string;
  password?: string;
  manual?: boolean;
  deep?: boolean;
}

export async function connect(appUrl: string, options: ConnectOptions): Promise<number> {
  const product = slugify(options.product);
  const profile = slugify(options.profile);

  log.blank();
  log.info(`${bold("product")} ${product}   ${bold("profile")} ${profile}`);

  const { browser, page, landingUrl } = await login({
    appUrl,
    profile,
    username: options.username,
    password: options.password,
    manual: options.manual,
  });

  try {
    const appMap = await buildAppMap(page, {
      profile,
      product,
      baseUrl: landingUrl,
      deep: options.deep,
    });
    writeArtifact(appMapPath(profile), AppMapSchema, appMap);

    log.blank();
    log.ok(`Connected. Landed on ${landingUrl}`);
    log.detail(`session  ${rel(storageStatePath(profile))}`);
    log.detail(`app map  ${rel(appMapPath(profile))} (${fmtCount(appMap.routes.length, "route")})`);
    for (const route of appMap.routes.slice(0, 12)) {
      log.detail(`  · ${route.label}${route.url ? "" : "  (button)"}`);
    }
    log.blank();
    log.info(
      `Next: vdg record "<what to demo>" --product ${product} --profile ${profile}`,
    );
    log.blank();
    return 0;
  } finally {
    await browser.close();
  }
}
