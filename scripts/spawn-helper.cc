/**
 * Patched spawn-helper for node-pty with macOS 26+ (Tahoe) compatibility.
 *
 * Root cause: on macOS 26, `ttyname(STDIN_FILENO)` returns NULL when called
 * inside a new session created by POSIX_SPAWN_SETSID. The original code
 * passes the return value of ttyname() directly to open(), which segfaults
 * when the pointer is NULL.
 *
 * Fix: check for NULL from ttyname() and fall back to TIOCSCTTY to attach
 * STDIN as the controlling terminal of the new session. This is backwards-
 * compatible — TIOCSCTTY is available on all supported macOS versions.
 *
 * See: https://github.com/microsoft/node-pty/issues/789
 *      https://github.com/openai/codex/issues/13926
 */

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

int main(int argc, char** argv) {
  char* slave_path = ttyname(STDIN_FILENO);

  // open() without O_NOCTTY implicitly attaches a process to a terminal
  // device when the process has no controlling terminal yet.
  // On macOS 26+, ttyname() may return NULL inside a POSIX_SPAWN_SETSID
  // session, so we fall back to TIOCSCTTY to set the controlling terminal.
  if (slave_path != NULL) {
    close(open(slave_path, O_RDWR));
  } else {
    ioctl(STDIN_FILENO, TIOCSCTTY, 0);
  }

  char* cwd  = argv[1];
  char* file = argv[2];
  argv = &argv[2];

  if (strlen(cwd) && chdir(cwd) == -1) {
    _exit(1);
  }

  execvp(file, argv);
  return 1;
}
