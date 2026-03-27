/**
 * vstack Safety Hook
 *
 * Blocks dangerous commands that could damage the pipeline:
 * - rm -rf inside public/ (destroys hardlinked source files)
 * - rm -rf inside scene-library/ (expensive to regenerate)
 * - git clean -f (could remove untracked pipeline files)
 */

const BLOCKED_PATTERNS = [
  { pattern: /rm\s+(-rf?|--recursive)\s+.*public/i, reason: 'BLOCKED: rm -rf inside public/ can destroy hardlinked source files.' },
  { pattern: /rm\s+(-rf?|--recursive)\s+.*scene-library/i, reason: 'BLOCKED: Deleting scene library would destroy expensive indexed data.' },
  { pattern: /rm\s+(-rf?|--recursive)\s+.*vstack-data/i, reason: 'BLOCKED: Deleting analysis data would require expensive re-analysis.' },
  { pattern: /git\s+clean\s+-[a-z]*f/i, reason: 'BLOCKED: git clean -f could remove untracked pipeline files.' },
];

export function checkCommand(command) {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { blocked: true, reason };
    }
  }
  return { blocked: false };
}
