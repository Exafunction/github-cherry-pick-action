import * as github from '@actions/github'
import * as core from '@actions/core'
import {PullRequest} from '@octokit/webhooks-types'

const ERROR_PR_REVIEW_FROM_AUTHOR =
  'Review cannot be requested from pull request author'

const CONFLICTS_DETECTED_WARNING = `## Cherry pick conflicts detected - please resolve conflicts and remove this line (cherrypick-conflict).\n\n`

export interface Inputs {
  token: string
  committer: string
  author: string
  branch: string
  title?: string
  body?: string
  labels: string[]
  inheritLabels?: boolean
  assignees: string[]
  reviewers: string[]
  teamReviewers: string[]
  cherryPickBranch?: string
  strategyOption?: string
  force?: boolean
  commitConflicts?: boolean
}

export async function createPullRequest(
  inputs: Inputs,
  prBranch: string,
  conflict: boolean
): Promise<any> {
  const octokit = github.getOctokit(inputs.token)
  if (!github.context.payload) {
    core.info(`Error: no payload in github.context`)
    return
  }
  const pull_request = github.context.payload.pull_request as PullRequest
  if (process.env.GITHUB_REPOSITORY !== undefined) {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/')

    // Get PR title
    core.info(`Input title is '${inputs.title}'`)
    let title = inputs.title
    if (title === undefined || title === '') {
      title = pull_request.title
    } else {
      // if the title comes from inputs, we replace {old_title}
      // so use users can set `title: 'Cherry pick: {old_title}`
      title = title.replace('{old_title}', pull_request.title)
    }

    // Get PR body
    core.info(`Input body is '${inputs.body}'`)
    let body = inputs.body
    if (body === undefined || body === '') {
      body = pull_request.body || undefined
    } else {
      // if the body comes from inputs, we replace {old_pull_request_id}
      // to make it easy to reference the previous pull request in the new
      body = body.replace(
        '{old_pull_request_id}',
        pull_request.number.toString()
      )
    }

    if (conflict) {
      title = `CONFLICT!!!! ${title}`
      body = `${CONFLICTS_DETECTED_WARNING}${body}`
    }
    core.info(`Using title '${title}'`)
    core.info(`Using body '${body}'`)

    // Create PR
    const pull = await octokit.rest.pulls.create({
      owner,
      repo,
      head: prBranch,
      base: inputs.branch,
      title,
      body
    })

    // Apply labels
    const appliedLabels = inputs.labels

    if (inputs.inheritLabels) {
      const prLabels = pull_request.labels
      if (prLabels) {
        for (const item of prLabels) {
          if (item.name !== inputs.branch) {
            appliedLabels.push(item.name)
          }
        }
      }
    }
    if (appliedLabels.length > 0) {
      core.info(`Applying labels '${appliedLabels}'`)
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: pull.data.number,
        labels: appliedLabels
      })
    }

    // Apply assignees
    if (inputs.assignees.length > 0) {
      core.info(`Applying assignees '${inputs.assignees}'`)
      await octokit.rest.issues.addAssignees({
        owner,
        repo,
        issue_number: pull.data.number,
        assignees: inputs.assignees
      })
    }

    // Request reviewers and team reviewers
    try {
      if (inputs.reviewers.length > 0) {
        core.info(`Requesting reviewers '${inputs.reviewers}'`)
        await octokit.rest.pulls.requestReviewers({
          owner,
          repo,
          pull_number: pull.data.number,
          reviewers: inputs.reviewers
        })
      }
      if (inputs.teamReviewers.length > 0) {
        core.info(`Requesting team reviewers '${inputs.teamReviewers}'`)
        await octokit.rest.pulls.requestReviewers({
          owner,
          repo,
          pull_number: pull.data.number,
          team_reviewers: inputs.teamReviewers
        })
      }
    } catch (e: unknown) {
      if (e instanceof Error) {
        if (e.message && e.message.includes(ERROR_PR_REVIEW_FROM_AUTHOR)) {
          core.warning(ERROR_PR_REVIEW_FROM_AUTHOR)
        } else {
          throw e
        }
      }
    }
    return pull
  }
}
