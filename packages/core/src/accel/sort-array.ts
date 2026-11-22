/**
 * Port of Godot's SortArray (introsort) — the exact sort used by the
 * lightmapper's `triangles.sort()`, `triangle_sort.sort()` and the cluster
 * median splits.
 *
 * Provenance: godot/core/templates/sort_array.h @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * Why a hand-rolled sort instead of `Array.prototype.sort`: Godot's
 * SortArray is a deterministic-but-UNSTABLE introsort (quicksort with
 * median-of-3 pivot + heap fallback + final insertion sort). The relative
 * order of equal keys shapes the GPU buffers (triangle order within a
 * slice, triangle indices within a grid cell), so we replicate the
 * algorithm exactly to stay byte-comparable with native dumps. Comparators
 * mirror the C++ `compare(a, b)` convention: strictly-less booleans.
 */

const INTROSORT_THRESHOLD = 16;

function swap<T>(a: T[], i: number, j: number): void {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

/** `SortArray::bitlog` — floor(log2(n)) for n >= 1. */
function bitlog(n: number): number {
  let k = 0;
  for (; n !== 1; n >>= 1) {
    ++k;
  }
  return k;
}

/** `SortArray::median_of_3_index`. */
function medianOf3Index<T>(p: T[], a: number, b: number, c: number, less: (x: T, y: T) => boolean): number {
  if (less(p[a], p[b])) {
    if (less(p[b], p[c])) {
      return b;
    } else if (less(p[a], p[c])) {
      return c;
    } else {
      return a;
    }
  } else if (less(p[a], p[c])) {
    return a;
  } else if (less(p[b], p[c])) {
    return c;
  } else {
    return b;
  }
}

/** `SortArray::push_heap`. */
function pushHeap<T>(first: number, holeIndex: number, topIndex: number, value: T, array: T[], less: (x: T, y: T) => boolean): void {
  let parent = (holeIndex - 1) / 2;
  while (holeIndex > topIndex && less(array[first + parent], value)) {
    array[first + holeIndex] = array[first + parent];
    holeIndex = parent;
    parent = (holeIndex - 1) / 2;
  }
  array[first + holeIndex] = value;
}

/** `SortArray::pop_heap` (4-arg form). */
function popHeapAt<T>(first: number, last: number, result: number, value: T, array: T[], less: (x: T, y: T) => boolean): void {
  array[result] = array[first];
  adjustHeap(first, 0, last - first, value, array, less);
}

/** `SortArray::adjust_heap`. */
function adjustHeap<T>(first: number, holeIndex: number, len: number, value: T, array: T[], less: (x: T, y: T) => boolean): void {
  const topIndex = holeIndex;
  let secondChild = 2 * holeIndex + 2;

  while (secondChild < len) {
    if (less(array[first + secondChild], array[first + (secondChild - 1)])) {
      secondChild--;
    }

    array[first + holeIndex] = array[first + secondChild];
    holeIndex = secondChild;
    secondChild = 2 * (secondChild + 1);
  }

  if (secondChild === len) {
    array[first + holeIndex] = array[first + (secondChild - 1)];
    holeIndex = secondChild - 1;
  }
  pushHeap(first, holeIndex, topIndex, value, array, less);
}

/** `SortArray::sort_heap`. */
function sortHeap<T>(first: number, lastIn: number, array: T[], less: (x: T, y: T) => boolean): void {
  let last = lastIn;
  while (last - first > 1) {
    // C++: pop_heap(p_first, p_last--, p_array) — the 3-arg form passes
    // (p_last - 1) as the heap end to the 5-arg form.
    popHeapAt(first, last - 1, last - 1, array[last - 1], array, less);
    last--;
  }
}

/** `SortArray::make_heap`. */
function makeHeap<T>(first: number, last: number, array: T[], less: (x: T, y: T) => boolean): void {
  if (last - first < 2) {
    return;
  }
  const len = last - first;
  let parent = (len - 2) / 2;

  for (;;) {
    adjustHeap(first, parent, len, array[first + parent], array, less);
    if (parent === 0) {
      return;
    }
    parent--;
  }
}

/** `SortArray::partial_sort`. */
function partialSort<T>(first: number, last: number, middle: number, array: T[], less: (x: T, y: T) => boolean): void {
  makeHeap(first, middle, array, less);
  for (let i = middle; i < last; i++) {
    if (less(array[i], array[first])) {
      popHeapAt(first, middle, i, array[i], array, less);
    }
  }
  sortHeap(first, middle, array, less);
}

/** `SortArray::partitioner` — pivot tracked by slot index (C++ tracks the pointer). */
function partitioner<T>(firstIn: number, lastIn: number, pivot: number, array: T[], less: (x: T, y: T) => boolean): number {
  let first = firstIn;
  let last = lastIn;
  let pivotLoc = pivot;

  for (;;) {
    while (first !== pivotLoc && less(array[first], array[pivotLoc])) {
      first++;
    }
    last--;
    while (last !== pivotLoc && less(array[pivotLoc], array[last])) {
      last--;
    }

    if (first >= last) {
      return first;
    }

    if (pivotLoc === first) {
      pivotLoc = last;
    } else if (pivotLoc === last) {
      pivotLoc = first;
    }
    swap(array, first, last);
    first++;
  }
}

/** `SortArray::introsort`. */
function introsort<T>(first: number, lastIn: number, array: T[], maxDepthIn: number, less: (x: T, y: T) => boolean): void {
  let last = lastIn;
  let maxDepth = maxDepthIn;
  while (last - first > INTROSORT_THRESHOLD) {
    if (maxDepth === 0) {
      partialSort(first, last, last, array, less);
      return;
    }

    maxDepth--;

    const cut = partitioner(
      first,
      last,
      medianOf3Index(array, first, first + ((last - first) / 2 | 0), last - 1, less),
      array,
      less,
    );

    introsort(cut, last, array, maxDepth, less);
    last = cut;
  }
}

/** `SortArray::unguarded_linear_insert`. */
function unguardedLinearInsert<T>(last: number, value: T, array: T[], less: (x: T, y: T) => boolean): void {
  let p = last;
  let next = p - 1;
  while (less(value, array[next])) {
    array[p] = array[next];
    p = next;
    next--;
  }
  array[p] = value;
}

/** `SortArray::linear_insert`. */
function linearInsert<T>(first: number, last: number, array: T[], less: (x: T, y: T) => boolean): void {
  const val = array[last];
  if (less(val, array[first])) {
    for (let i = last; i > first; i--) {
      array[i] = array[i - 1];
    }
    array[first] = val;
  } else {
    unguardedLinearInsert(last, val, array, less);
  }
}

/** `SortArray::insertion_sort`. */
function insertionSort<T>(first: number, last: number, array: T[], less: (x: T, y: T) => boolean): void {
  if (first === last) {
    return;
  }
  for (let i = first + 1; i !== last; i++) {
    linearInsert(first, i, array, less);
  }
}

/** `SortArray::unguarded_insertion_sort`. */
function unguardedInsertionSort<T>(first: number, last: number, array: T[], less: (x: T, y: T) => boolean): void {
  for (let i = first; i !== last; i++) {
    unguardedLinearInsert(i, array[i], array, less);
  }
}

/** `SortArray::final_insertion_sort`. */
function finalInsertionSort<T>(first: number, last: number, array: T[], less: (x: T, y: T) => boolean): void {
  if (last - first > INTROSORT_THRESHOLD) {
    insertionSort(first, first + INTROSORT_THRESHOLD, array, less);
    unguardedInsertionSort(first + INTROSORT_THRESHOLD, last, array, less);
  } else {
    insertionSort(first, last, array, less);
  }
}

/**
 * Port of `SortArray::sort_range` — sorts `[first, first + count)` in place
 * with exactly Godot's introsort permutation. C++ sorts sub-ranges via
 * pointer + count (e.g. `sorter.sort(&arr[start], count)`); use this for
 * those so equal-key behavior matches native.
 */
export function sortArrayRange<T>(array: T[], first: number, count: number, less: (a: T, b: T) => boolean): void {
  const last = first + count;
  if (first !== last) {
    introsort(first, last, array, bitlog(last - first) * 2, less);
    finalInsertionSort(first, last, array, less);
  }
}

/**
 * Port of `SortArray::sort` — in-place, exactly replicating Godot's
 * introsort permutation (including equal-key order). `less(a, b)` must be
 * a strict weak order mirroring the C++ `Comparator::operator()`.
 */
export function sortArray<T>(array: T[], less: (a: T, b: T) => boolean): void {
  sortArrayRange(array, 0, array.length, less);
}
