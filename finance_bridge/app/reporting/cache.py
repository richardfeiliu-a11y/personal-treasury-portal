"""Thread-safe TTL + single-flight cache for report computations.

Same-key concurrent callers share one in-flight computation (single-flight);
expired entries are recomputed. Factory runs outside the lock so slow
computations never block other keys.

Memory contract: retention is bounded by the number of distinct keys ever seen,
not by the TTL — an expired entry is dropped only the next time its own key is
read, so nothing is evicted on a schedule. Keep key cardinality small and
fixed: do not add ever-incrementing dimensions (timestamps, per-day values,
request ids) to a key without considering unbounded growth.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable
from concurrent.futures import Future
from typing import Generic, TypeVar

K = TypeVar("K")
V = TypeVar("V")


class TTLFlightCache(Generic[K, V]):
    """TTL cache with single-flight deduplication for concurrent same-key calls."""

    def __init__(self, ttl_seconds: float):
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._values: dict[K, tuple[float, V]] = {}
        self._flights: dict[K, Future[V]] = {}

    def get_or_compute(self, key: K, factory: Callable[[], V]) -> V:
        now = time.monotonic()
        with self._lock:
            cached = self._values.get(key)
            if cached is not None and cached[0] > now:
                return cached[1]
            if cached is not None:
                self._values.pop(key, None)
            flight = self._flights.get(key)
            leader = flight is None
            if leader:
                flight = Future()
                self._flights[key] = flight

        assert flight is not None
        if not leader:
            return flight.result()

        try:
            value = factory()
        except BaseException as exc:
            with self._lock:
                self._flights.pop(key, None)
            flight.set_exception(exc)
            raise

        with self._lock:
            self._values[key] = (time.monotonic() + self._ttl, value)
            self._flights.pop(key, None)
        flight.set_result(value)
        return value

    def clear(self) -> None:
        with self._lock:
            self._values.clear()
