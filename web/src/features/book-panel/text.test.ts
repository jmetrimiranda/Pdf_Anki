import { describe, expect, it } from 'vitest';
import type { PageWords } from '../../lib/core/types';
import {
  codeText,
  commandText,
  exampleSentence,
  guessLanguage,
  previewLine,
  proseText,
  proseToHtml,
  singleWord,
  suggestKind,
} from './text';

function page(text: string): PageWords {
  const words = [...text.matchAll(/\S+/g)].map((m, index) => ({
    index,
    text: m[0],
    start: m.index,
    end: m.index + m[0].length,
    rects: [[m.index * 5, 100, m[0].length * 5, 12] as [number, number, number, number]],
  }));
  return { page: 0, width: 600, height: 800, text, words };
}

describe('proseText', () => {
  it('collapses PDF line breaks and joins hyphenated words', () => {
    expect(proseText('  The wind-\nmill was\n  built\tagain. ')).toBe('The windmill was built again.');
    expect(proseText('well-known\nfact')).toBe('well-known fact');
  });
});

describe('codeText', () => {
  it('keeps line breaks and indentation', () => {
    expect(codeText('\r\nros2 run demo talker  \r\n  --ros-args\n\n')).toBe('ros2 run demo talker\n  --ros-args');
  });
});

describe('proseToHtml', () => {
  it('escapes and keeps typed line breaks', () => {
    expect(proseToHtml('a < b\nc & d')).toBe('a &lt; b<br>c &amp; d');
  });
});

describe('singleWord', () => {
  it('accepts one word with surrounding punctuation', () => {
    expect(singleWord(' “Animals,” ')).toBe('Animals');
    expect(singleWord("don't")).toBe("don't");
    expect(singleWord('well-known.')).toBe('well-known');
  });

  it('rejects several words, digits and empty text', () => {
    expect(singleWord('two words')).toBeNull();
    expect(singleWord('1984')).toBeNull();
    expect(singleWord('well--known')).toBeNull();
    expect(singleWord('line\nbreak')).toBeNull();
    expect(singleWord(' ... ')).toBeNull();
    expect(singleWord('x'.repeat(65))).toBeNull();
    expect(singleWord('(Boxer)')).toBe('Boxer');
    expect(singleWord('ação')).toBe('ação');
  });
});

describe('exampleSentence', () => {
  const text = 'Mr. Jones was drunk. All animals are equal! The pigs said so. Other animals agreed.';
  it('takes the sentence of the selected occurrence and bolds the word', () => {
    const p = page(text);
    const second = p.words.find((w) => w.text === 'animals' && w.start > 50)!;
    expect(exampleSentence(p, 'animals', second.rects)).toBe('Other <b>animals</b> agreed.');
    expect(exampleSentence(p, 'animals', [])).toBe('All <b>animals</b> are equal!');
  });

  it('falls back to the word', () => {
    expect(exampleSentence(null, 'windmill', [])).toBe('<b>windmill</b>');
    expect(exampleSentence(page('nothing here'), 'windmill', [])).toBe('<b>windmill</b>');
  });

  it('cuts very long sentences around the word', () => {
    const long = `${'word '.repeat(200)}target ${'more '.repeat(200)}`;
    const html = exampleSentence(page(long), 'target', []);
    expect(html).toContain('<b>target</b>');
    expect(html.length).toBeLessThan(360);
    expect(html.startsWith('…')).toBe(true);
    expect(html.endsWith('…')).toBe(true);
  });
});

describe('previewLine', () => {
  it('cuts with an ellipsis', () => {
    expect(previewLine('a\nb')).toBe('a b');
    expect(previewLine('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('suggestKind', () => {
  const cases: [string, 'basic' | 'codeCommand' | 'codeProgram'][] = [
    // Commands (1–3 lines).
    ['ros2 run turtlesim turtlesim_node', 'codeCommand'],
    ['$ ros2 run turtlesim turtlesim_node', 'codeCommand'],
    ['# apt install ros-jazzy-desktop', 'codeCommand'],
    ['sudo apt install ros-humble-desktop', 'codeCommand'],
    ['apt-get update', 'codeCommand'],
    ['colcon build --packages-select my_pkg', 'codeCommand'],
    ['source install/setup.bash', 'codeCommand'],
    ['. install/setup.bash', 'codeCommand'],
    ['ls -la', 'codeCommand'],
    ['cd ~/ros2_ws/src', 'codeCommand'],
    ['mkdir -p ~/ros2_ws/src', 'codeCommand'],
    ['grep -rn "talker" src', 'codeCommand'],
    ['tar -xzf ros.tar.gz', 'codeCommand'],
    ['chmod +x script.py', 'codeCommand'],
    ['git clone https://github.com/ros/ros_tutorials.git -b jazzy', 'codeCommand'],
    ['pip install numpy', 'codeCommand'],
    ['python3 talker.py', 'codeCommand'],
    ['docker run --rm -it ros:jazzy', 'codeCommand'],
    ['cmake ..', 'codeCommand'],
    ['make -j4', 'codeCommand'],
    ['g++ -std=c++20 main.cpp -o main', 'codeCommand'],
    ['rosdep install -i --from-path src --rosdistro jazzy -y', 'codeCommand'],
    ['export ROS_DOMAIN_ID=5', 'codeCommand'],
    ['ros2 topic echo /chatter | head -n 5', 'codeCommand'],
    ['mytool --verbose run', 'codeCommand'],
    ['cd ~/ros2_ws\ncolcon build --symlink-install\nsource install/setup.bash', 'codeCommand'],
    ['ros2 topic pub /turtle1/cmd_vel geometry_msgs/msg/Twist \\\n  "{linear: {x: 2.0}}"', 'codeCommand'],
    // Programs (multi-line).
    ['def soma_pares(xs):\n    return sum(x for x in xs if x % 2 == 0)', 'codeProgram'],
    ['import rclpy\nfrom rclpy.node import Node\n\nclass Talker(Node):\n    pass', 'codeProgram'],
    ['for i in range(3):\n    print(i)', 'codeProgram'],
    ['#include <iostream>\nint main() {\n  std::cout << "oi";\n}', 'codeProgram'],
    ['int soma(int a, int b) {\n  return a + b;\n}', 'codeProgram'],
    // Prose (Animal Farm) never becomes code.
    ['All animals are equal, but some animals are more equal than others.', 'basic'],
    ['Four legs good, two legs bad.', 'basic'],
    ['Napoleon is always right.', 'basic'],
    ['make the windmill work again', 'basic'],
    ['source of all their troubles', 'basic'],
    ['export the surplus grain to the neighbouring farms.', 'basic'],
    [
      'Mr. Jones, of the Manor Farm, had locked the hen-houses for the night,\nbut was too drunk to remember to shut the pop-holes.',
      'basic',
    ],
    [
      'The creatures outside looked from pig to man, and from man to pig,\nand from pig to man again; but already it was impossible to say which was which.',
      'basic',
    ],
    ['windmill', 'basic'],
    ['', 'basic'],
    ['I will work harder.\nNapoleon is always right.\nFour legs good, two legs bad.\nAll animals are equal.', 'basic'],
  ];
  it.each(cases)('%j → %s', (text, kind) => {
    expect(suggestKind(text)).toBe(kind);
  });

  it('guesses the language and strips prompts', () => {
    expect(guessLanguage('def f():\n    return 1')).toBe('python');
    expect(guessLanguage('#include <vector>\nstd::vector<int> v;')).toBe('cpp');
    expect(commandText('$ ros2 run turtlesim turtlesim_node\n# apt update')).toBe(
      'ros2 run turtlesim turtlesim_node\napt update',
    );
  });
});
