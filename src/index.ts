import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import * as io from '@actions/io'
import {PullRequest} from '@octokit/webhooks-types'
import {Inputs, createPullRequest} from './github-helper'
import * as utils from './utils'

const CHERRYPICK_EMPTY =
  'The previous cherry-pick is now empty, possibly due to conflict resolution.'
const CHERRYPICK_CONFLICT = 'CONFLICT(content)'

export async function run(): Promise<void> {
  try {
    const inputs: Inputs = {
      token: core.getInput('token'),
      committer: core.getInput('committer'),
      author: core.getInput('author'),
      branch: core.getInput('branch'),
      title: core.getInput('title'),
      body: core.getInput('body'),
      force: utils.getInputAsBoolean('force'),
      labels: utils.getInputAsArray('labels'),
      inheritLabels: utils.getInputAsBoolean('inherit-labels'),
      assignees: utils.getInputAsArray('assignees'),
      reviewers: utils.getInputAsArray('reviewers'),
      teamReviewers: utils.getInputAsArray('team-reviewers'),
      cherryPickBranch: core.getInput('cherry-pick-branch'),
      strategyOption: core.getInput('strategy-option'),
      commitConflicts: utils.getInputAsBoolean('commit-conflicts')
    }

    core.info(`Cherry pick into branch ${inputs.branch}!`)

    // the value of merge_commit_sha changes depending on the status of the pull request
    // see https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request
    const githubSha = (github.context.payload.pull_request as PullRequest)
      .merge_commit_sha
    const prBranch = inputs.cherryPickBranch
      ? inputs.cherryPickBranch
      : `cherry-pick-${inputs.branch}-${githubSha}`

    // Configure the committer and author
    core.startGroup('Configuring the committer and author')
    const parsedAuthor = utils.parseDisplayNameEmail(inputs.author)
    const parsedCommitter = utils.parseDisplayNameEmail(inputs.committer)
    core.info(
      `Configured git committer as '${parsedCommitter.name} <${parsedCommitter.email}>'`
    )
    await gitExecution(['config', '--global', 'user.name', parsedAuthor.name])
    await gitExecution([
      'config',
      '--global',
      'user.email',
      parsedCommitter.email
    ])
    core.endGroup()

    // Update  branchs
    core.startGroup('Fetch all branchs')
    await gitExecution(['remote', 'update'])
    await gitExecution(['fetch', '--all'])
    core.endGroup()

    // Create branch new branch
    core.startGroup(`Create new branch ${prBranch} from ${inputs.branch}`)
    await gitExecution(['checkout', '-b', prBranch, `origin/${inputs.branch}`])
    core.endGroup()

    // Cherry pick
    core.startGroup('Cherry picking')
    let conflict = false
    const result = await gitExecution(
      [
        'cherry-pick',
        '-m',
        '1',
        '--strategy=recursive',
        `--strategy-option=${inputs.strategyOption ?? 'theirs'}`,
        `${githubSha}`
      ],
      false
    )
    if (
      result.exitCode !== 0 &&
      !result.stderr.includes(CHERRYPICK_EMPTY) &&
      !result.stdout.includes(CHERRYPICK_CONFLICT)
    ) {
      throw new Error(`Unhandled error: ${result.stderr}`)
    }

    // Handle conflicts by finding and committing conflicted files
    if (result.stdout.includes(CHERRYPICK_CONFLICT)) {
      conflict = true
      if (!inputs.commitConflicts) {
        throw new Error(
          'Conflicts detected but commit-conflicts is set to false'
        )
      }

      core.info(
        'Conflicts detected. Finding and committing conflicted files...'
      )

      // Find all files with conflicts
      const conflictResult = await gitExecution([
        'diff',
        '--name-only',
        '--diff-filter=U'
      ])

      if (conflictResult.stdout.trim()) {
        const conflictedFiles = conflictResult.stdout.trim().split('\n')
        core.info(
          `Found ${conflictedFiles.length} files with conflicts: ${conflictedFiles.join(', ')}`
        )

        // Add all conflicted files
        await gitExecution(['add', ...conflictedFiles])

        // Commit the resolved conflicts
        await gitExecution([
          'commit',
          '-m',
          `Resolved conflicts in cherry-pick of ${githubSha}`
        ])
        core.info('Committed resolved conflicts')
      }
    }

    core.endGroup()

    // Push new branch
    core.startGroup('Push new branch to remote')
    if (inputs.force) {
      await gitExecution(['push', '-u', 'origin', `${prBranch}`, '--force'])
    } else {
      await gitExecution(['push', '-u', 'origin', `${prBranch}`])
    }
    core.endGroup()

    // Create pull request
    core.startGroup('Opening pull request')
    const pull = await createPullRequest(inputs, prBranch, conflict)
    core.setOutput('data', JSON.stringify(pull.data))
    core.setOutput('number', pull.data.number)
    core.setOutput('html_url', pull.data.html_url)
    core.endGroup()
  } catch (err: unknown) {
    if (err instanceof Error) {
      core.setFailed(err)
    }
  }
}

async function gitExecution(
  params: string[],
  failOnNonZeroExit = true
): Promise<GitOutput> {
  const result = new GitOutput()
  const stdout: string[] = []
  const stderr: string[] = []

  const options = {
    listeners: {
      stdout: (data: Buffer) => {
        stdout.push(data.toString())
      },
      stderr: (data: Buffer) => {
        stderr.push(data.toString())
      }
    },
    ignoreReturnCode: !failOnNonZeroExit
  }

  const gitPath = await io.which('git', true)
  result.exitCode = await exec.exec(gitPath, params, options)
  result.stdout = stdout.join('')
  result.stderr = stderr.join('')

  if (result.exitCode === 0) {
    core.info(result.stdout.trim())
  } else {
    core.info(result.stderr.trim())
  }

  return result
}

class GitOutput {
  stdout = ''
  stderr = ''
  exitCode = 0
}

// do not run if imported as module
if (require.main === module) {
  run()
}
