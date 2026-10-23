// check.hpp: the CHECK macro of the C++ code cards in mode `testes` (Leitor de Estudos, spec 11.5).
// Written next to the sources of every run; user files can't replace it.
// CHECK(expr) prints exactly `PASS <expr>` or `FAIL <expr> (<file>:<line>)` and a newline to stdout, flushes, and
// makes the program exit with status 1 at the end if any check failed. Header-only, C++20, no exceptions.
#pragma once

#include <cstdio>
#include <cstdlib>

namespace leitor_check {

inline int& failures() noexcept {
    static int count = 0;
    return count;
}

inline void exit_with_failures() noexcept {
    if (failures() > 0) {
        std::fflush(stdout);
        std::_Exit(1);
    }
}

inline bool install_exit_hook() noexcept {
    std::atexit(exit_with_failures);
    return true;
}

// One instance per program (inline variable), registered before main runs.
inline const bool exit_hook_installed = install_exit_hook();

inline void check(bool ok, const char* expr, const char* file, int line) noexcept {
    if (ok) {
        std::printf("PASS %s\n", expr);
    } else {
        ++failures();
        std::printf("FAIL %s (%s:%d)\n", expr, file, line);
    }
    std::fflush(stdout);
}

}  // namespace leitor_check

// Variadic so expressions with top-level commas (`CHECK(f(std::vector<int>{1, 2}) == 3)`) still work.
#define CHECK(...) ::leitor_check::check(static_cast<bool>(__VA_ARGS__), #__VA_ARGS__, __FILE__, __LINE__)
