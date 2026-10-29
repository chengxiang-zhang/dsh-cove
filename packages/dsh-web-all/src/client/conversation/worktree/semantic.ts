/**
 * Semantic attribute values for the worktree capability. Its surface is the
 * conversation header chip and the popover that chip opens: there is no
 * sidebar entry and no management panel anymore.
 */
export const WORKTREE_PLUGIN = 'worktree'
/** Conversation header chip showing the session's branch (lane or main checkout). */
export const WORKTREE_PART_LANE_CHIP = 'lane-chip'
/** Popover opened from the lane chip: the lane's facts plus its teardown actions. */
export const WORKTREE_PART_LANE_MENU = 'lane-menu'