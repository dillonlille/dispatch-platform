import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';

const brotli = promisify(brotliCompress),
  gz = promisify(gzip);

/** Prepare static representations once at build time; requests never compress assets. */
export async function compressAssets(directory: string) {
  const files = await fs.readdir(directory);
  await Promise.all(
    files
      .filter((name) => /\.(?:js|css|svg|glb)$/.test(name))
      .map(async (name) => {
        const file = path.join(directory, name),
          bytes = await fs.readFile(file);
        if (bytes.length < 1024) return;
        const variants = await Promise.all([
          brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
          gz(bytes, { level: 9 }),
        ]);
        await Promise.all(
          variants.map((encoded, index) =>
            encoded.length < bytes.length
              ? fs.writeFile(`${file}.${index === 0 ? 'br' : 'gz'}`, encoded)
              : undefined,
          ),
        );
      }),
  );
}
