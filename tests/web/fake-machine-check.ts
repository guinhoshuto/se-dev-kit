import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * A fake maquina_livre.py in `folder`, busy with `reason` while the file `busy` exists. Each call appends
 * its arguments and the pid in the render slot's owner.json (`none` without one) to `calls`, so a test
 * sees who asked, for which family, and whether the asker held the slot.
 */
export async function fakeMachineCheck(folder: string, reason: string): Promise<{script: string; busy: string; calls: string}> {
  const files = {script: join(folder, 'maquina_livre.py'), busy: join(folder, 'busy'), calls: join(folder, 'calls.log')};
  await writeFile(files.busy, '');
  await writeFile(files.script, [
    'import json, os, sys',
    'here = os.path.dirname(os.path.abspath(__file__))',
    'try:',
    "    holder = json.load(open(os.path.join(os.environ['RENDER_SLOT_DIR'], 'owner.json')))['pid']",
    'except Exception:',
    "    holder = 'none'",
    "with open(os.path.join(here, 'calls.log'), 'a') as f: f.write(' '.join(sys.argv[1:]) + ' slot=' + str(holder) + '\\n')",
    "waiting = os.path.exists(os.path.join(here, 'busy'))",
    `print(json.dumps({'livre': not waiting, 'motivos': [], 'reasons': [${JSON.stringify(reason)}] if waiting else []}))`,
    'sys.exit(3 if waiting else 0)'
  ].join('\n'));
  return files;
}
