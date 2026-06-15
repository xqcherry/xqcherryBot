const STABILITY_ORDER = {
  stable: 0,
  'semi-stable': 1,
  dynamic: 2,
}

export class CachePolicy {
  apply(blocks = []) {
    return annotateStableBoundary(blocks.map(block => cloneBlock(block)))
  }
}

function cloneBlock(block) {
  return {
    ...block,
    metadata: block.metadata ? { ...block.metadata } : undefined,
  }
}

function annotateStableBoundary(blocks) {
  const lastStableIndex = findStablePrefixEnd(blocks)
  if (lastStableIndex < 0) return blocks
  const block = blocks[lastStableIndex]
  blocks[lastStableIndex] = {
    ...block,
    metadata: {
      ...(block.metadata ?? {}),
      cacheBoundary: 'stable-prefix-end',
    },
  }
  return blocks
}

function findStablePrefixEnd(blocks) {
  let lastStableIndex = -1
  for (let index = 0; index < blocks.length; index += 1) {
    const rank = STABILITY_ORDER[blocks[index].stability] ?? STABILITY_ORDER.dynamic
    if (rank !== STABILITY_ORDER.stable) break
    lastStableIndex = index
  }
  return lastStableIndex
}
