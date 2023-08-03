/* eslint-disable no-console */
import { join, relative } from 'path';
import { type Options as ExecaOptions } from 'execa';
import pLimit from 'p-limit';
import prettyTime from 'pretty-hrtime';
import { copy, emptyDir, ensureDir, move, remove, writeFile } from 'fs-extra';
import { program } from 'commander';
import { directory } from 'tempy';
import { execSync } from 'child_process';
import { execaCommand } from '../utils/exec';

import type { OptionValues } from '../utils/options';
import { createOptions } from '../utils/options';
import { allTemplates as sandboxTemplates } from '../../code/lib/cli/src/sandbox-templates';
import { JsPackageManagerFactory } from '../../code/lib/cli/src/js-package-manager/JsPackageManagerFactory';

import { maxConcurrentTasks } from '../utils/maxConcurrentTasks';

import type { GeneratorConfig } from './utils/types';
import { getStackblitzUrl, renderTemplate } from './utils/template';
import type { JsPackageManager } from '../../code/lib/cli/src/js-package-manager';
import {
  BEFORE_DIR_NAME,
  AFTER_DIR_NAME,
  SCRIPT_TIMEOUT,
  REPROS_DIRECTORY,
  LOCAL_REGISTRY_URL,
} from '../utils/constants';
import { beforeShutdown } from './utils/before-shutdown';

const sbInit = async (cwd: string, flags?: string[], debug?: boolean) => {
  const sbCliBinaryPath = join(__dirname, `../../code/lib/cli/bin/index.js`);
  console.log(`🎁 Installing storybook`);
  const env = { STORYBOOK_DISABLE_TELEMETRY: 'true' };
  const fullFlags = ['--yes', ...(flags || [])];
  await runCommand(`${sbCliBinaryPath} init ${fullFlags.join(' ')}`, { cwd, env }, debug);
};

const withLocalRegistry = async (packageManager: JsPackageManager, action: () => Promise<void>) => {
  const prevUrl = await packageManager.getRegistryURL();
  let error;

  try {
    console.log(`📦 Configuring local registry: ${LOCAL_REGISTRY_URL}`);
    packageManager.setRegistryURL(LOCAL_REGISTRY_URL);
    await action();
  } catch (e) {
    error = e;
  } finally {
    console.log(`📦 Restoring registry: ${prevUrl}`);
    await packageManager.setRegistryURL(prevUrl);

    if (error) {
      // eslint-disable-next-line no-unsafe-finally
      throw error;
    }
  }
};

const addStorybook = async ({
  dir,
  localRegistry,
  flags,
  debug,
  dirName,
}: {
  dir: string;
  localRegistry: boolean;
  flags?: string[];
  debug?: boolean;
  dirName: string;
}) => {
  const packageManager = await JsPackageManagerFactory.getPackageManager({}, dir);
  const legacyPeerDeps = (await execaCommand('npm config get audit')).stdout;

  // Prerelease versions of Angular are not allowed per default in the defined peer dependency range of @storybook/angular
  // Therefore we have to activate the legacy-peer-deps mode for it to allow installation nevertheless
  if (dirName === 'angular-cli/prerelease') {
    execSync('npm config set legacy-peer-deps true');

    beforeShutdown(() => {
      execSync(`npm config set legacy-peer-deps ${legacyPeerDeps}`);
    });
  }

  if (localRegistry) {
    await withLocalRegistry(packageManager, async () => {
      await sbInit(dir, flags, debug);
    });
  } else {
    await sbInit(dir, flags, debug);
  }

  if (dirName === 'angular-cli/prerelease') {
    execSync(`npm config set legacy-peer-deps ${legacyPeerDeps}`);
  }
};

export const runCommand = async (script: string, options: ExecaOptions, debug = false) => {
  if (debug) {
    console.log(`Running command: ${script}`);
  }

  return execaCommand(script, {
    stdout: debug ? 'inherit' : 'ignore',
    shell: true,
    ...options,
  });
};

const addDocumentation = async (
  dir: string,
  { name, dirName }: { name: string; dirName: string }
) => {
  const stackblitzConfigPath = join(__dirname, 'templates', '.stackblitzrc');
  const readmePath = join(__dirname, 'templates', 'item.ejs');

  await copy(stackblitzConfigPath, join(dir, '.stackblitzrc'));

  const stackblitzUrl = getStackblitzUrl(dirName);
  const contents = await renderTemplate(readmePath, {
    name,
    stackblitzUrl,
  });
  await writeFile(join(dir, 'README.md'), contents);
};

const improveNPMPerformance = async () => {
  const preferOffline = (await execaCommand('npm config get prefer-offline')).stdout;
  const audit = (await execaCommand('npm config get audit')).stdout;

  await execaCommand('npm config set prefer-offline true');
  await execaCommand('npm config set audit false');

  beforeShutdown(() => {
    execSync(`npm config set prefer-offline ${preferOffline}`);
    execSync(`npm config set audit ${audit}`);
  });
};

const runGenerators = async (
  generators: (GeneratorConfig & { dirName: string })[],
  localRegistry = true,
  debug = false
) => {
  console.log(`🤹‍♂️ Generating sandboxes with a concurrency of ${maxConcurrentTasks}`);

  const limit = pLimit(1);

  await improveNPMPerformance();

  await Promise.all(
    generators.map(({ dirName, name, script, expected }) =>
      limit(async () => {
        let flags: string[] = [];
        if (expected.renderer === '@storybook/html') flags = ['--type html'];
        else if (expected.renderer === '@storybook/server') flags = ['--type server'];

        const time = process.hrtime();
        console.log(`🧬 Generating ${name}`);

        const baseDir = join(REPROS_DIRECTORY, dirName);
        const beforeDir = join(baseDir, BEFORE_DIR_NAME);
        const afterDir = join(baseDir, AFTER_DIR_NAME);

        await emptyDir(baseDir);

        // We do the creation inside a temp dir to avoid yarn container problems
        const tempDir = directory();

        const tempInitDir = join(tempDir, BEFORE_DIR_NAME);

        // Some tools refuse to run inside an existing directory and replace the contents,
        // where as others are very picky about what directories can be called. So we need to
        // handle different modes of operation.
        if (script.includes('{{beforeDir}}')) {
          const scriptWithBeforeDir = script.replaceAll('{{beforeDir}}', BEFORE_DIR_NAME);

          await runCommand(
            scriptWithBeforeDir,
            {
              cwd: tempDir,
              timeout: SCRIPT_TIMEOUT,
              stderr: 'inherit',
              env: {
                // CRA for example uses npm_config_user_agent to determine if it should use yarn or npm
                // eslint-disable-next-line no-nested-ternary
                npm_config_user_agent: scriptWithBeforeDir.startsWith('yarn')
                  ? 'yarn'
                  : scriptWithBeforeDir.startsWith('pnpm')
                  ? 'pnpm'
                  : 'npm',
              },
            },
            debug
          );
        } else {
          await ensureDir(tempInitDir);
          await runCommand(script, { cwd: tempInitDir, timeout: SCRIPT_TIMEOUT }, debug);
        }

        // Move the initialized project into the beforeDir without node_modules and .git
        await copy(tempInitDir, beforeDir, {
          filter: (src) => {
            return src.indexOf('node_modules') === -1 && src.indexOf('.git') === -1;
          },
        });

        await addStorybook({ dir: tempInitDir, localRegistry, flags, debug, dirName });

        await move(tempInitDir, afterDir);

        await addDocumentation(afterDir, { name, dirName });

        // Remove node_modules to save space and avoid GH actions failing
        // They're not uploaded to the git sandboxes repo anyway
        if (process.env.CLEANUP_SANDBOX_NODE_MODULES) {
          console.log(`🗑️ Removing ${join(afterDir, 'node_modules')}`);
          await remove(join(afterDir, 'node_modules'));
        }

        await remove(tempDir);

        console.log(
          `✅ Created ${dirName} in ./${relative(
            process.cwd(),
            baseDir
          )} successfully in ${prettyTime(process.hrtime(time))}`
        );
      })
    )
  );
};

export const options = createOptions({
  template: {
    type: 'string',
    description: 'Which template would you like to create?',
    values: Object.keys(sandboxTemplates),
  },
  localRegistry: {
    type: 'boolean',
    description: 'Generate reproduction from local registry?',
    promptType: false,
  },
  debug: {
    type: 'boolean',
    description: 'Print all the logs to the console',
    promptType: false,
  },
});

export const generate = async ({
  template,
  localRegistry,
  debug,
}: OptionValues<typeof options>) => {
  const generatorConfigs = Object.entries(sandboxTemplates)
    .map(([dirName, configuration]) => ({
      dirName,
      ...configuration,
    }))
    .filter(({ dirName }) => {
      if (template) {
        return dirName === template;
      }

      return true;
    });

  await runGenerators(generatorConfigs, localRegistry, debug);
};

if (require.main === module) {
  program
    .description('Generate sandboxes from a set of possible templates')
    .option('--template <template>', 'Create a single template')
    .option('--debug', 'Print all the logs to the console')
    .option('--local-registry', 'Use local registry', false)
    .action((optionValues) => {
      generate(optionValues)
        .catch((e) => {
          console.trace(e);
          process.exit(1);
        })
        .then(() => {
          // FIXME: Kill dangling processes. For some reason in CI,
          // the abort signal gets executed but the child process kill
          // does not succeed?!?
          process.exit(0);
        });
    })
    .parse(process.argv);
}
