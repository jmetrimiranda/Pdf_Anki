import type { CommandSpec, ToolSpec } from './types';
import { flag, value, variadic } from './types';

/** Options shared by the `ros2 topic|node|service|param|action …` verbs that talk to the graph. */
const graph = [flag('--use-sim-time'), flag('--no-daemon'), value('--spin-time')];

const leaf = (spec: CommandSpec = {}): CommandSpec => spec;

/** `ros2` (spec 11.3). Tables are per subcommand path: `-r` is `--rate` in `topic pub`. */
export const ros2: ToolSpec = {
  id: 'ros2',
  names: ['ros2'],
  combineShortFlags: false,
  rosTypes: true,
  root: {
    subcommands: {
      run: leaf({ options: [value('--prefix')] }),
      launch: leaf({
        positionals: 'launch',
        options: [flag('--debug', '-d'), flag('--show-args', '-s'), flag('--print', '-p'), value('--launch-prefix')],
      }),
      topic: {
        options: [...graph, flag('--include-hidden-topics')],
        subcommands: {
          list: leaf({ options: [flag('--show-types', '-t'), flag('--count-topics', '-c'), flag('--verbose', '-v')] }),
          echo: leaf({
            options: [
              flag('--once'),
              value('--field'),
              value('--qos-profile'),
              flag('--no-arr'),
              flag('--no-str'),
              flag('--csv'),
              flag('--full-length', '-f'),
            ],
          }),
          pub: leaf({
            options: [
              flag('--once', '-1'),
              value('--rate', '-r'),
              value('--times', '-t'),
              value('--qos-profile'),
              flag('--keep-alive'),
            ],
          }),
          info: leaf({ options: [flag('--verbose', '-v')] }),
          hz: leaf({ options: [value('--window', '-w'), value('--filter')] }),
          bw: leaf({ options: [value('--window', '-w')] }),
          type: leaf(),
          find: leaf({ options: [flag('--count-topics', '-c')] }),
        },
      },
      node: {
        options: graph,
        subcommands: {
          list: leaf({ options: [flag('--all', '-a'), flag('--count-nodes', '-c')] }),
          info: leaf({ options: [flag('--include-hidden')] }),
        },
      },
      service: {
        options: [...graph, flag('--include-hidden-services')],
        subcommands: {
          list: leaf({ options: [flag('--show-types', '-t'), flag('--count-services', '-c')] }),
          call: leaf({ options: [value('--rate', '-r')] }),
          type: leaf(),
          find: leaf({ options: [flag('--count-services', '-c')] }),
        },
      },
      param: {
        options: graph,
        subcommands: {
          list: leaf({ options: [flag('--param-type'), flag('--include-hidden-nodes')] }),
          get: leaf({ options: [flag('--hide-type')] }),
          set: leaf(),
          dump: leaf({ options: [value('--output-dir'), flag('--print')] }),
          load: leaf({ options: [flag('--no-use-wildcard')] }),
          delete: leaf(),
        },
      },
      action: {
        options: graph,
        subcommands: {
          list: leaf({ options: [flag('--show-types', '-t'), flag('--count-actions', '-c')] }),
          info: leaf({ options: [flag('--show-types', '-t'), flag('--count', '-c')] }),
          send_goal: leaf({ options: [flag('--feedback', '-f')] }),
        },
      },
      interface: {
        subcommands: {
          list: leaf({ options: [flag('--only-msgs', '-m'), flag('--only-srvs', '-s'), flag('--only-actions', '-a')] }),
          show: leaf({ options: [flag('--all-comments'), flag('--no-comments')] }),
          proto: leaf({ options: [flag('--no-quotes')] }),
          package: leaf(),
          packages: leaf({ options: [flag('--only-msgs', '-m'), flag('--only-srvs', '-s'), flag('--only-actions', '-a')] }),
        },
      },
      pkg: {
        subcommands: {
          create: leaf({
            options: [
              value('--build-type'),
              variadic('--dependencies'),
              value('--node-name'),
              value('--license'),
              value('--description'),
              value('--destination-directory'),
              value('--maintainer-email'),
              value('--maintainer-name'),
              value('--library-name'),
            ],
          }),
          executables: leaf({ options: [flag('--full-path')] }),
          list: leaf(),
          prefix: leaf({ options: [flag('--share')] }),
          xml: leaf({ options: [value('--tag', '-t')] }),
        },
      },
      bag: {
        subcommands: {
          record: leaf({
            positionals: 'set',
            options: [
              flag('--all', '-a'),
              value('--output', '-o'),
              value('--storage', '-s'),
              value('--exclude', '-x'),
              value('--regex', '-e'),
              value('--max-bag-size', '-b'),
              value('--max-bag-duration', '-d'),
              value('--compression-mode'),
              value('--compression-format'),
              flag('--include-hidden-topics'),
            ],
          }),
          play: leaf({
            options: [value('--rate', '-r'), flag('--loop', '-l'), variadic('--topics'), value('--storage', '-s')],
          }),
          info: leaf({ options: [value('--storage', '-s')] }),
        },
      },
      doctor: leaf({ options: [flag('--report', '-r'), flag('--report-failed', '-rf'), flag('--include-warnings', '-iw')] }),
      daemon: { subcommands: { start: leaf(), stop: leaf(), status: leaf() } },
      component: {
        options: graph,
        subcommands: { list: leaf(), load: leaf(), unload: leaf(), standalone: leaf(), types: leaf() },
      },
      lifecycle: {
        options: graph,
        subcommands: { get: leaf(), set: leaf(), list: leaf(), nodes: leaf() },
      },
    },
  },
};
