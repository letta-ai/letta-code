import { expect, test } from "bun:test";
import { commandRunsForegroundSleep } from "./foreground-sleep";

test.each([
  "sleep 3",
  'python -c "import time; time.sleep(2.5)"',
  "python3 -c 'import time\nwhile True: time.sleep(2)'",
  'python3 -c "from time import sleep; sleep(.5)"',
  "python3 -c 'import time\nfor _ in range(3):\n    time.sleep(1)'",
  'node -e "setTimeout(() => {}, 1000)"',
  'node --eval "new Promise(resolve => setTimeout(resolve, 1000))"',
  'bash -c "sleep 3"',
  'sh -c "until test -f ready; do sleep 1; done"',
  "bash -lc 'python3 -c \"import time; time.sleep(3)\"'",
  'perl -e "sleep 1"',
  'perl -e "sleep 1 while 1"',
])("blocks foreground delay in %s", (command) => {
  expect(commandRunsForegroundSleep(command)).toBe(true);
});

test.each([
  "grep sleep sleep.log",
  "cat /tmp/sleep",
  "python3 sleep.py",
  'python3 sleep.py -c "import time; time.sleep(5)"',
  "python -c 'print(\"import time; time.sleep(5)\")'",
  'python3 -c "import time; time.sleep(1); print(time.time())"',
  "node -e 'console.log(\"setTimeout(() => {}, 1000)\")'",
  'node -e "setTimeout(() => console.log(Date.now()), 10)"',
  'bash -c "grep sleep sleep.log"',
  "sh -c 'echo \"sleep 5\"'",
  "bash -c 'cat <<EOF\nsleep 5\nEOF'",
  "perl -e 'print \"sleep 5\"'",
  'perl -e "sleep 1; print time"',
])("allows ordinary command %s", (command) => {
  expect(commandRunsForegroundSleep(command)).toBe(false);
});
