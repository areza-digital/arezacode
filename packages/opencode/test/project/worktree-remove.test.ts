import { $ } from "bun"
import { describe, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { Project } from "../../src/project/project"
import { InstanceState } from "../../src/effect/instance-state"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Worktree.node, Project.node]), [
    [
      InstanceStore.bootstrapNode,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)
const wintest = process.platform === "win32" ? it.instance : it.instance.skip

describe("Worktree.remove", () => {
  it.instance(
    "rejects unrelated directories and the primary worktree without deleting contents",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const unrelated = path.join(root, "unrelated")
        yield* Effect.promise(() => fs.mkdir(unrelated))
        yield* Effect.promise(() => fs.writeFile(path.join(unrelated, "keep.txt"), "keep"))
        for (const directory of [unrelated, root]) {
          expect(yield* svc.remove({ directory }).pipe(Effect.flip)).toBeInstanceOf(Worktree.RemoveFailedError)
          expect(yield* Effect.promise(() => fs.readFile(path.join(unrelated, "keep.txt"), "utf8"))).toBe("keep")
        }
      }),
    { git: true },
  )

  it.instance(
    "cleans a detached worktree directory only when project ownership is recorded",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const project = yield* Project.Service
        const ctx = yield* InstanceState.context
        const directory = path.join(root, "detached")
        yield* Effect.promise(() => fs.mkdir(directory))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "leftover.txt"), "leftover"))
        yield* project.addSandbox(ctx.project.id, directory)
        expect(yield* svc.remove({ directory })).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs.stat(directory).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "continues when git remove exits non-zero after detaching",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const name = `remove-regression-${Date.now().toString(36)}`
        const branch = `opencode/${name}`
        const dir = path.join(root, "..", name)

        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())

        const real = (yield* Effect.promise(() => $`which git`.quiet().text())).trim()
        expect(real).toBeTruthy()

        const bin = path.join(root, "bin")
        const shim = path.join(bin, "git")
        yield* Effect.promise(() => fs.mkdir(bin, { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            shim,
            [
              "#!/bin/bash",
              `REAL_GIT=${JSON.stringify(real)}`,
              'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
              '  "$REAL_GIT" "$@" >/dev/null 2>&1',
              '  echo "fatal: failed to remove worktree: Directory not empty" >&2',
              "  exit 1",
              "fi",
              'exec "$REAL_GIT" "$@"',
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() => fs.chmod(shim, 0o755))

        const prev = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const prev = process.env.PATH ?? ""
            process.env.PATH = `${bin}${path.delimiter}${prev}`
            return prev
          }),
          (prev) =>
            Effect.sync(() => {
              process.env.PATH = prev
            }),
        )
        void prev

        const ok = yield* svc.remove({ directory: dir })

        expect(ok).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        const list = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(root).quiet().text())
        expect(list).not.toContain(`worktree ${dir}`)

        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).not.toBe(0)
      }),
    { git: true },
  )

  wintest(
    "stops fsmonitor before removing a worktree",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const name = `remove-fsmonitor-${Date.now().toString(36)}`
        const branch = `opencode/${name}`
        const dir = path.join(root, "..", name)

        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())
        yield* Effect.promise(() => $`git config core.fsmonitor true`.cwd(dir).quiet())
        yield* Effect.promise(() => $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow())
        yield* Effect.promise(() => Bun.write(path.join(dir, "tracked.txt"), "next\n"))
        yield* Effect.promise(() => $`git diff`.cwd(dir).quiet())

        const before = yield* Effect.promise(() => $`git fsmonitor--daemon status`.cwd(dir).quiet().nothrow())
        expect(before.exitCode).toBe(0)

        const ok = yield* svc.remove({ directory: dir })

        expect(ok).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).not.toBe(0)
      }),
    { git: true },
  )
})
