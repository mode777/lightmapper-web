/**
 * TypeScript port of stb_rect_pack.h v1.01 (Skyline Bottom-Left) as used by
 * Godot's `Geometry2D::partial_pack_rects`.
 *
 * Provenance: godot/thirdparty/misc/stb_rect_pack.h (v1.01, 2021-07-11) @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0, invoked from
 * godot/core/math/geometry_2d.cpp (`partial_pack_rects`) which Godot
 * compiles with STB_RECT_PACK_IMPLEMENTATION.
 * License: dual MIT / public domain — Sean Barrett (see NOTICE.md).
 *
 * Ported faithfully with two documented deviations:
 *
 * PORT: nodes are indices into a preallocated array (C pointers → numbers;
 * `-1` is NULL). `prev_link` is encoded as `null` (C NULL), `-1`
 * (points at `context.active_head`) or a node index (points at that node's
 * `next` field).
 *
 * PORT: `qsort` is replaced by JS `Array.prototype.sort` (stable). The
 * unsort comparator (`rect_original_order`) is a total order, so only
 * equal-(w,h) ties can differ from a native run — and there they do:
 * glibc's modern qsort is an unstable introsort, so Godot itself permutes
 * equal-size rects depending on the libc. The packed LAYOUT (multiset of
 * occupied rects) is invariant, verified empirically: this port matches a
 * gcc-compiled driver of Godot's vendored stb_rect_pack.h on 3000 random
 * cases / 56300 rects with zero layout differences; the only divergence
 * is which same-sized rect takes which of the identical slots.
 *
 * PORT: the `STBRP_HEURISTIC_Skyline_BF_sortHeight` (best-fit) branch of
 * `stbrp__skyline_find_best_pos` is omitted — Godot never calls
 * `stbrp_setup_heuristic`, so the heuristic is always the default
 * Skyline Bottom-Left.
 */

const STBRP__MAXVAL = 0x7fffffff;

const STBRP__INIT_SKYLINE = 1;
const STBRP_HEURISTIC_Skyline_default = 0; // == Skyline_BL_sortHeight

/** Mirrors `stbrp_node` with `next` as an index (-1 = NULL). */
interface StbrpNode {
  x: number;
  y: number;
  next: number;
}

/** Mirrors `stbrp_context` (user nodes first, then the two `extra` nodes). */
export interface StbrpContext {
  width: number;
  height: number;
  align: number;
  initMode: number;
  heuristic: number;
  numNodes: number;
  nodes: StbrpNode[]; // length numNodes + 2; extra = [numNodes, numNodes + 1]
  activeHead: number;
  freeHead: number; // -1 = NULL
}

/** Mirrors `stbrp_rect`. */
export interface StbrpRect {
  id: number;
  w: number;
  h: number;
  x: number;
  y: number;
  wasPacked: number;
}

/** Port of `stbrp_setup_allow_out_of_mem`. */
function stbrpSetupAllowOutOfMem(context: StbrpContext, allowOutOfMem: boolean): void {
  if (allowOutOfMem) {
    // if it's ok to run out of memory, then don't bother aligning them;
    // this gives better packing, but may fail due to OOM (even though
    // the rectangles easily fit).
    context.align = 1;
  } else {
    // if it's not ok to run out of memory, then quantize the widths
    // so that num_nodes is always enough nodes: align = ceil(width/num_nodes)
    context.align = ((context.width + context.numNodes - 1) / context.numNodes) | 0;
  }
}

/**
 * Port of `stbrp_init_target`. Allocates `numNodes + 2` nodes internally
 * (the +2 are the context's `extra` nodes).
 */
export function stbrpInitTarget(width: number, height: number, numNodes: number): StbrpContext {
  const nodes: StbrpNode[] = new Array(numNodes + 2);
  for (let i = 0; i < nodes.length; i++) {
    nodes[i] = { x: 0, y: 0, next: -1 };
  }
  const context: StbrpContext = {
    width: 0,
    height: 0,
    align: 1,
    initMode: 0,
    heuristic: 0,
    numNodes,
    nodes,
    activeHead: -1,
    freeHead: -1,
  };

  for (let i = 0; i < numNodes - 1; ++i) {
    nodes[i].next = i + 1;
  }
  nodes[numNodes - 1].next = -1;
  context.initMode = STBRP__INIT_SKYLINE;
  context.heuristic = STBRP_HEURISTIC_Skyline_default;
  context.freeHead = 0;
  context.activeHead = numNodes; // &context->extra[0]
  context.width = width;
  context.height = height;
  context.numNodes = numNodes;
  stbrpSetupAllowOutOfMem(context, false);

  // node 0 is the full width, node 1 is the sentinel (lets us not store width explicitly)
  nodes[numNodes].x = 0;
  nodes[numNodes].y = 0;
  nodes[numNodes].next = numNodes + 1;
  nodes[numNodes + 1].x = width;
  nodes[numNodes + 1].y = 1 << 30;
  nodes[numNodes + 1].next = -1;

  return context;
}

/** Read the linked-node slot `link`: -1 = `context.activeHead`, else `nodes[link].next`. */
function getLink(c: StbrpContext, link: number): number {
  return link === -1 ? c.activeHead : c.nodes[link].next;
}

/** Write the linked-node slot `link` (see `getLink`). */
function setLink(c: StbrpContext, link: number, value: number): void {
  if (link === -1) {
    c.activeHead = value;
  } else {
    c.nodes[link].next = value;
  }
}

/** find minimum y position if it starts at x1 — port of `stbrp__skyline_find_min_y`. */
function stbrpSkylineFindMinY(c: StbrpContext, first: number, x0: number, width: number): { minY: number; waste: number } {
  let node = first;
  const x1 = x0 + width;
  let minY = 0;
  let wasteArea = 0;
  let visitedWidth = 0;
  while (c.nodes[node].x < x1) {
    const n = c.nodes[node];
    const next = c.nodes[n.next];
    if (n.y > minY) {
      // raise min_y higher.
      // we've accounted for all waste up to min_y,
      // but we'll now add more waste for everything we've visted
      wasteArea += visitedWidth * (n.y - minY);
      minY = n.y;
      // the first time through, visited_width might be reduced
      if (n.x < x0) {
        visitedWidth += next.x - x0;
      } else {
        visitedWidth += next.x - n.x;
      }
    } else {
      // add waste area
      let underWidth = next.x - n.x;
      if (underWidth + visitedWidth > width) {
        underWidth = width - visitedWidth;
      }
      wasteArea += underWidth * (minY - n.y);
      visitedWidth += underWidth;
    }
    node = n.next;
  }

  return { minY, waste: wasteArea };
}

/** Port of `stbrp__skyline_find_best_pos` (Bottom-Left heuristic only). */
function stbrpSkylineFindBestPos(c: StbrpContext, width: number, height: number): { prevLink: number | null; x: number; y: number } {
  const bestY0 = 1 << 30;
  let bestY = bestY0;
  let best: number | null = null;

  // align to multiple of c->align
  width = width + c.align - 1;
  width -= width % c.align;

  // if it can't possibly fit, bail immediately
  if (width > c.width || height > c.height) {
    return { prevLink: null, x: 0, y: 0 };
  }

  let node = c.activeHead;
  let prev = -1; // &c->active_head
  while (c.nodes[node].x + width <= c.width) {
    // bottom left
    const { minY: y } = stbrpSkylineFindMinY(c, node, c.nodes[node].x, width);
    if (y < bestY) {
      bestY = y;
      best = prev;
    }
    prev = node; // &node->next
    node = c.nodes[node].next;
  }

  const bestX = best === null ? 0 : c.nodes[getLink(c, best)].x;

  return { prevLink: best, x: bestX, y: bestY };
}

/** Port of `stbrp__skyline_pack_rectangle`. */
function stbrpSkylinePackRectangle(context: StbrpContext, width: number, height: number): { prevLink: number | null; x: number; y: number } {
  // find best position according to heuristic
  const res = stbrpSkylineFindBestPos(context, width, height);

  // bail if:
  //    1. it failed
  //    2. the best node doesn't fit (we don't always check this)
  //    3. we're out of memory
  if (res.prevLink === null || res.y + height > context.height || context.freeHead === -1) {
    return { prevLink: null, x: res.x, y: res.y };
  }

  // on success, create new node
  const nodeIndex = context.freeHead;
  const node = context.nodes[nodeIndex];
  node.x = res.x;
  node.y = res.y + height;

  context.freeHead = node.next;

  // insert the new node into the right starting point, and
  // let 'cur' point to the remaining nodes needing to be
  // stiched back in
  let curIndex = getLink(context, res.prevLink);
  let cur = context.nodes[curIndex];
  if (cur.x < res.x) {
    // preserve the existing one, so start testing with the next one
    const next = cur.next;
    cur.next = nodeIndex;
    curIndex = next;
    cur = context.nodes[curIndex];
  } else {
    setLink(context, res.prevLink, nodeIndex);
  }

  // from here, traverse cur and free the nodes, until we get to one
  // that shouldn't be freed
  while (cur.next !== -1 && context.nodes[cur.next].x <= res.x + width) {
    const next = cur.next;
    // move the current node to the free list
    cur.next = context.freeHead;
    context.freeHead = curIndex;
    curIndex = next;
    cur = context.nodes[curIndex];
  }

  // stitch the list back in
  node.next = curIndex;

  if (cur.x < res.x + width) {
    cur.x = res.x + width;
  }

  return res;
}

/** Port of `rect_height_compare` (height desc, then width desc). */
function rectHeightCompare(a: StbrpRect, b: StbrpRect): number {
  if (a.h > b.h) return -1;
  if (a.h < b.h) return 1;
  return a.w > b.w ? -1 : a.w < b.w ? 1 : 0;
}

/** Port of `rect_original_order` (total order by initial index). */
function rectOriginalOrder(a: StbrpRect, b: StbrpRect): number {
  return a.wasPacked < b.wasPacked ? -1 : a.wasPacked > b.wasPacked ? 1 : 0;
}

/** Port of `stbrp_pack_rects`. Returns 1 iff every rectangle was packed. */
export function stbrpPackRects(context: StbrpContext, rects: StbrpRect[]): number {
  let allRectsPacked = 1;

  // we use the 'was_packed' field internally to allow sorting/unsorting
  for (let i = 0; i < rects.length; ++i) {
    rects[i].wasPacked = i;
  }

  // sort according to heuristic
  rects.sort(rectHeightCompare);

  for (let i = 0; i < rects.length; ++i) {
    if (rects[i].w === 0 || rects[i].h === 0) {
      rects[i].x = rects[i].y = 0; // empty rect needs no space
    } else {
      const fr = stbrpSkylinePackRectangle(context, rects[i].w, rects[i].h);
      if (fr.prevLink !== null) {
        rects[i].x = fr.x;
        rects[i].y = fr.y;
      } else {
        rects[i].x = rects[i].y = STBRP__MAXVAL;
      }
    }
  }

  // unsort
  rects.sort(rectOriginalOrder);

  // set was_packed flags and all_rects_packed status
  for (let i = 0; i < rects.length; ++i) {
    rects[i].wasPacked = rects[i].x === STBRP__MAXVAL && rects[i].y === STBRP__MAXVAL ? 0 : 1;
    if (!rects[i].wasPacked) {
      allRectsPacked = 0;
    }
  }

  // return the all_rects_packed status
  return allRectsPacked;
}

/**
 * Port of `Geometry2D::partial_pack_rects` (core/math/geometry_2d.cpp):
 * pack `sizes` into an `atlasWidth x atlasHeight` target and return, per
 * input rect (original order), `[x, y, packed]` where `packed` is 0/1.
 * Unpacked rects carry stb's `STBRP__MAXVAL` sentinel coordinates, exactly
 * like Godot's `Vector3i(rects[i].x, rects[i].y, was_packed)` mapping.
 */
export function partialPackRects(
  sizes: ReadonlyArray<readonly [number, number]>,
  atlasWidth: number,
  atlasHeight: number,
): Array<[number, number, number]> {
  // Godot allocates one node per atlas-width unit (memset to 0).
  const context = stbrpInitTarget(atlasWidth, atlasHeight, atlasWidth);

  const rects: StbrpRect[] = new Array(sizes.length);
  for (let i = 0; i < sizes.length; i++) {
    rects[i] = {
      id: i,
      w: sizes[i][0],
      h: sizes[i][1],
      x: 0,
      y: 0,
      wasPacked: 0,
    };
  }

  stbrpPackRects(context, rects);

  const ret: Array<[number, number, number]> = new Array(sizes.length);
  for (let i = 0; i < sizes.length; i++) {
    ret[rects[i].id] = [rects[i].x, rects[i].y, rects[i].wasPacked !== 0 ? 1 : 0];
  }

  return ret;
}
