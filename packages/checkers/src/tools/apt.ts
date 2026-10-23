import type { CommandSpec, ToolSpec } from './types';
import { flag, harmless } from './types';

const packages = (spec: CommandSpec = {}): CommandSpec => ({ positionals: 'set', ...spec });

/** `apt` / `apt-get` (spec 11.3): `apt` ≡ `apt-get`; `-y`, `--yes`, `-q` are harmless. */
export const apt: ToolSpec = {
  id: 'apt',
  names: ['apt', 'apt-get'],
  combineShortFlags: false,
  root: {
    options: [harmless('--yes', '-y', '--assume-yes'), harmless('--quiet', '-q'), flag('--no-install-recommends')],
    subcommands: {
      install: packages({ options: [flag('--reinstall'), flag('--only-upgrade')] }),
      remove: packages(),
      purge: packages(),
      autoremove: packages(),
      update: {},
      upgrade: packages(),
    },
  },
};
