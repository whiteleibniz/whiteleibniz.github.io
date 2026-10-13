---
title: Quick Start Guide Git
date: 2018-07-12 07:01:31
lang: en
permalink: en/2018/07/12/Quick-Start-Guide-Git/
tags:
- Quick Start Guide
- Git
typora-root-url: Quick-Start-Guide-Git
---
## Git Common Command Reference
 ![git-command](git-command.PNG)
## Introduction to Git

Git is currently the world's most advanced **distributed** version control system (no exception).

### Centralized vs. Distributed

-   Centralized network topology
    ![Centralized topology](集中式.PNG)
-   Distributed topology
    ![Distributed topology](分布式.PNG)

## Installing Git

### Installing on Linux

```shell
$ sudo apt-get install git
```

### Installing on Windows

To use Git on Windows, you can download the installer directly from the [official website](https://git-scm.com/downloads) (if your network connection is slow, download it from the [domestic mirror](https://pan.baidu.com/s/1kU5OCOB#list/path=%2Fpub%2Fgit)), and then install it with the default options.

After the installation is complete, find "Git" -> "Git Bash" in the Start menu. If a window similar to a command line pops up, Git has been installed successfully!

After the installation, there is one final setup step. Enter the following in the command line:

```shell
$ git config --global user.name "Your Name"
$ git config --global user.email "email@example.com"
```

Because Git is a distributed version control system, every machine must identify itself: your name and email address. You may worry about what happens if someone deliberately impersonates someone else. There is no need to worry about this. First, we believe that everyone is a kind and naive member of the public; second, if impersonation really happens, there are ways to trace it.

Note the --global option of the git config command. Using this option means that all Git repositories on this machine will use this configuration. Of course, you can also specify a different username and email address for a particular repository.

## Creating a Repository

First, choose a suitable place and create an empty directory:

```shell
$ mkdir learngit
$ cd learngit
$ pwd
/Users/wlb/learngit
```

Second, use the git init command to turn this directory into a repository that Git can manage:

```shell
$ git init
Initialized empty Git repository in /Users/wlb/learngit/.git/
```

### Adding Files to the Repository

Now let's write a readme.txt file with the following content:

```text
Git is a version control system.
Git is free software.
```

Step 1: use the git add command to tell Git to add the file to the repository:

```shell
$ git add readme.txt
```

Step 2: use the git commit command to tell Git to commit the file to the repository:

```shell
$ git commit -m "wrote a readme file"
[master (root-commit) eaadf4e] wrote a readme file
 1 file changed, 2 insertions(+)
 create mode 100644 readme.txt
```

## Version Management

We have successfully added and committed a readme.txt file. Now it is time to continue working, so we continue to modify readme.txt and change it to the following content:

```text
Git is a "distributed" version control system.
Git is free software.
```

Now, run the git status command to see the result:

```shell
$ git status
On branch master
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git checkout -- <file>..." to discard changes in working directory)

    modified:   readme.txt

no changes added to commit (use "git add" and/or "git commit -a")
```

To see exactly what has been changed, use the git diff command to take a look:

```shell
$ git diff readme.txt
diff --git a/readme.txt b/readme.txt
index 46d49bf..9247db6 100644
--- a/readme.txt
+++ b/readme.txt
@@ -1,2 +1,2 @@
-Git is a version control system.
+Git is a distributed version control system.
 Git is free software.
```

Adding and committing modified files

```shell
$ git add readme.txt

$ git status
On branch master
Changes to be committed:
  (use "git reset HEAD <file>..." to unstage)

    modified:   readme.txt

$ git commit -m "add distributed"
[master e475afc] add distributed
 1 file changed, 1 insertion(+), 1 deletion(-)

$ git status
On branch master
nothing to commit, working tree clean
```

### Rolling Back to a Previous Version

Modify readme.txt again as follows:

```text
Git is a distributed version control system.
Git is free software distributed under the GPL
```

Then try to commit:

```shell
$ git add readme.txt
$ git commit -m "append GPL"
[master 1094adb] append GPL
 1 file changed, 1 insertion(+), 1 deletion(-)
```

Now let's review how many versions of readme.txt have been committed to the Git repository:
Version 1: wrote a readme file

```text
Git is a version control system.
Git is free software
```

Version 2: add distributed

```text
Git is a distributed version control system.
Git is free software.
```

Version 3: append GPL

```text
Git is a distributed version control system.
Git is free software distributed under the GPL.
```

In practical work, we use the git log --pretty=oneline command to view the changes of each commit. --pretty=oneline is a condensed format (optional).

```shell
$ git log --pretty=oneline
1094adb7b9b3807259d8cb349e7df1d4d6477073 (HEAD -> master) append GPL
e475afc93c209a690c39c13a46716e8fa000c366 add distributed
eaadf4e385e865d25c48e7ca9c8395c3f7dfaef0 wrote a readme file
```

Now, if you are ready to roll readme.txt back to the previous version, that is, the add distributed version, how do you do it? First, let's look at the principle of Git rollback. Git rolls back versions very quickly, because Git internally has a HEAD pointer that points to the current version. When you roll back a version, Git simply changes HEAD from pointing at append GPL to pointing at add distributed:

![HEAD pointer](head.jpg)
![HEAD2 pointer](head2.jpg)

We can use the git reset --hard command to roll back to a previous version:

```shell
$ git reset --hard HEAD^
HEAD is now at e475afc add distributed
```

HEAD represents the current version. The previous version is HEAD^, the version before that is HEAD^^, and 100 versions back is HEAD~100. Of course, you can also roll back to the corresponding version directly through the commit id:

```shell
$ git reset --hard 1094a
HEAD is now at 83b0afe append GPL
```

As long as you have the commit id, the pointer can switch to any version, whether rolling back or restoring. Sometimes, after rolling back to the previous version, you cannot know the commit id from before the rollback. To restore it, we need to use the git reflog command to find the commit id from before the rollback:

```shell
$ git reflog
e475afc HEAD@{1}: reset: moving to HEAD^
1094adb (HEAD -> master) HEAD@{2}: commit: append GPL
e475afc HEAD@{3}: commit: add distributed
eaadf4e HEAD@{4}: commit (initial): wrote a readme file
```

If the changes have not yet been pushed to the Git server (on the premise that local modifications have not been pushed), you can look up the commit id of the corresponding version.

### Working Directory and Staging Area

Working directory: the directory you can see on your computer. For example, my learngit folder is a working directory (the hidden .git directory does not belong to the working directory).
Repository: the working directory contains a hidden directory .git, which is Git's repository. The repository includes the stage (staging area), master (branch), and HEAD (a pointer pointing to master).
Staging area: the stage (also called index) part inside the repository.
The relationship among the three is shown in the figure:

![Working directory and staging area](workandstage.jpg)

The first step is to use git add to add the file modifications in the working directory (creating a new file also counts as a file modification) to the stage; in effect, this adds the modifications to the staging area.
The second step is to use git commit to commit the changes; in effect, this commits all the content in the staging area to the current branch.

### Managing Modifications

Git manages modifications. After you use the git add command, the first modification in the working directory is placed in the staging area and is ready to be committed. However, the second modification in the working directory is not placed in the staging area. Therefore, git commit only commits the modifications in the staging area; that is, the first modification is committed, and the second modification will not be committed.

Then how do you commit the second modification? You can run git add again and then git commit. Alternatively, do not rush to commit the first modification: run git add for the second modification first, and then git commit, which is equivalent to merging the two modifications and committing them together:

First modification -> git add -> second modification -> git add -> git commit

Summary: for every modification, if you do not git add it to the staging area, it will not be included in the commit.

### Discarding Modifications

Let's look at a few scenarios where discarding modifications applies:
Scenario 1: when you have messed up the content of a file in the working directory and want to discard the modifications in the working directory directly, use the command git checkout -- file.

Scenario 2: when you have not only messed up the content of a file in the working directory but also added it to the staging area, and you want to discard the modification, there are two steps: first use the command git reset HEAD <file>, which returns to Scenario 1, and then follow the Scenario 1 procedure.

Scenario 3: when you have committed an improper modification to the repository and want to undo this commit, refer to the Version Rollback section. However, the premise is that it has not been pushed to the remote repository.
![Discarding modifications](撤销修改.png)
Understand it with the figure:
Scenario 1: equivalent to discarding modifications in the working directory (unstage changes).
Scenario 2: equivalent to undoing staged changes back to unstage changes, and then performing Scenario 1.
Scenario 3: there are two cases:
1. Full undo: git reset --hard "commit-id" undoes all the changes in the working directory. When there are changes you do not want to undo, this command is fatal.
2. Safe undo: git reset --soft HEAD^ is equivalent to the undo in the figure. It only withdraws the commit made at that time, without affecting the current changes in the working directory.

### Deleting Files

There are two cases for deleting a file:
The first is when you really want to delete the file from the repository. In that case, use the git rm command to delete it, and then git commit:

```shell
$ git rm test.txt
rm 'test.txt'

$ git commit -m "remove test.txt"
[master d46f35e] remove test.txt
 1 file changed, 1 deletion(-)
 delete mode 100644 test.txt
```

The other case is that you deleted the wrong file. Since it is still in the repository, you can easily restore the mistakenly deleted file to the latest version:

```shell
$ git checkout -- test.txt
```

## Remote Repositories

Please register a GitHub account yourself. Since the transmission between your local Git repository and the GitHub repository is encrypted through SSH, some setup is required:

Step 1: create an SSH Key. In the user home directory, check whether there is an .ssh directory. If so, check whether this directory contains the two files id_rsa and id_rsa.pub. If they already exist, you can skip directly to the next step. If not, open the Shell (on Windows, open Git Bash) and create an SSH Key:

```shell
$ ssh-keygen -t rsa -C "youremail@example.com"
```

You need to replace the email address with your own email address, and then press Enter all the way to use the default values. Since this Key is not for military purposes, there is no need to set a password.

If everything goes well, you can find the .ssh directory in the user home directory, which contains the two files id_rsa and id_rsa.pub. These two files are the SSH Key pair: id_rsa is the private key, which must not be leaked, and id_rsa.pub is the public key, which can be safely told to anyone.

Step 2: log in to GitHub and open the "Account settings" and "SSH Keys" pages:

Then, click "Add SSH Key", fill in any Title, and paste the content of the id_rsa.pub file into the Key text box:

![githubssh](githubssh.png)

### Adding a Remote Repository

First, log in to GitHub, then find the "Create a new repo" button in the upper right corner and create a new repository named learngit:

Currently, this learngit repository on GitHub is still empty. GitHub tells us that **we can either clone a new repository from this repository, or associate an existing local repository with it**, and then push the content of the local repository to the GitHub repository.

Since we initialized the repository locally, we use the second method to associate the remote repository:

```shell
$ git remote add origin git@github.com:whiteleibniz/learngit.git
```

Next, you can push all the content of the local repository to the remote repository:

```shell
$ git push -u origin master
Counting objects: 20, done.
Delta compression using up to 4 threads.
Compressing objects: 100% (15/15), done.
Writing objects: 100% (20/20), 1.64 KiB | 560.00 KiB/s, done.
Total 20 (delta 5), reused 0 (delta 0)
remote: Resolving deltas: 100% (5/5), done.
To github.com:whiteleibniz/learngit.git
 * [new branch]      master -> master
Branch 'master' set up to track remote branch 'master' from 'origin'.
```

Since the remote repository is empty, when we pushed the master branch for the first time, we added the -u option. Git not only pushes the content of the local master branch to the new remote master branch, but also associates the local master branch with the remote master branch, so that commands can be simplified for future pushes or pulls.

### Cloning from a Remote Repository

Last time we talked about how to associate a remote repository when there is first a local repository and then a remote repository.

Now, suppose we are developing from scratch. The best approach is to create the remote repository first, and then clone from the remote repository.

First, log in to GitHub and create a new repository named gitskills:

The remote repository is ready. The next step is to use the git clone command to clone a local repository:

```shell
$ git clone git@github.com:whiteleibniz/gitskills.git
Cloning into 'gitskills'...
remote: Counting objects: 3, done.
remote: Total 3 (delta 0), reused 0 (delta 0), pack-reused 3
Receiving objects: 100% (3/3), done.
```

## Branch Management

A branch is like a parallel universe in a science fiction movie. While you are working hard in front of your computer to learn Git, another you is working hard in another parallel universe to learn SVN.

If the two parallel universes do not interfere with each other, they have no impact on the current you. However, at some point in time, the two parallel universes merge, and as a result, you have learned both Git and SVN!

![branch](branch.png)

What is the use of branches in practice? Suppose you are going to develop a new feature, but it will take two weeks to complete. In the first week, you have written 50% of the code. If you commit immediately, because the code is not finished, the incomplete codebase will prevent others from working. If you wait until all the code is finished and commit it all at once, there is a huge risk of losing daily progress.

Now that you have branches, there is no need to be afraid. You create a branch that belongs to you. Others cannot see it and continue to work normally on the original branch, while you work on your own branch and commit whenever you want. Once the development is complete, you merge everything into the original branch at once. This way, it is both safe and does not affect the work of others.

Other version control systems such as SVN also have branch management, but after using them you will find that creating and switching branches in these version control systems is slower than a snail, which is simply unbearable. As a result, the branch feature becomes a decoration and nobody uses it.

But Git's branches are different. No matter whether you create, switch, or delete a branch, Git can complete it within 1 second! No matter whether your repository has 1 file or 10,000 files.

### Creating and Merging Branches

Creating a branch is essentially creating a new pointer to a commit at a certain point in time on the original branch, and then pointing the HEAD pointer to that branch pointer. The principle is shown in the figure below:
Creating a branch:
![branch](branch-dev.png)
Branch commit:
![branch](branch-commit.png)
Branch merge: the git merge command is used to merge **a specified branch into the current branch**.
![branch](branch-merge.png)
Deleting a branch: after the merge, the branch is basically useless and can be deleted. Deleting a branch means deleting the branch pointer.
![branch](branch-del.png)

Common branch operation commands:

View branches: git branch

Create a branch: git branch  <name>

Switch branches: git checkout  <name>

Create + switch branches: git checkout -b  <name>

Merge a branch into the current branch: git merge  <name>

Delete a branch: git branch -d  <name>

### Resolving Conflicts

The cause of conflicts and how to resolve them:
When the same file is modified in both the main branch and a branch, and both modifications are committed, Git cannot perform an automatic merge. You need to manually edit the files that failed to merge into the content we want.

The message Git gives when executing the merge command:

```shell
$ git merge feature1
Auto-merging readme.txt
CONFLICT (content): Merge conflict in readme.txt
Automatic merge failed; fix conflicts and then commit the result.
```

Use git status to view the specific cause of the conflict:

```shell
$ git status
On branch master
Your branch is ahead of 'origin/master' by 2 commits.
  (use "git push" to publish your local commits)

You have unmerged paths.
  (fix conflicts and run "git commit")
  (use "git merge --abort" to abort the merge)

Unmerged paths:
  (use "git add <file>..." to mark resolution)

    both modified:   readme.txt

no changes added to commit (use "git add" and/or "git commit -a")
```

View the content of the conflicted readme file:

```text
Git is a distributed version control system.
Git is free software distributed under the GPL.
Git has a mutable index called stage.
Git tracks changes of files.
<<<<<<< HEAD
Creating a new branch is quick & simple.
=======
Creating a new branch is quick AND simple.
>>>>>>> feature1
```

Git uses <<<<<<<, =======, and >>>>>>> to mark the content of different branches. We modify it as follows and save it:

```shell
Creating a new branch is quick and simple.
```

Execute the commit:

```shell
$ git add readme.txt
$ git commit -m "conflict fixed"
[master cf810e4] conflict fixed
```

### Branch Management Strategy

In practical development, we should follow several basic principles for branch management:

First, the master branch should be very stable, that is, it is only used to release new versions, and you should not work on it normally;

So where should you work? Work is done on the dev branch, that is, the dev branch is unstable. At some point, for example, when version 1.0 is released, the dev branch is merged into master, and version 1.0 is released on the master branch;

You and your teammates all work on the dev branch, each person has their own branch, and you merge into the dev branch from time to time.

Therefore, the branches for team collaboration look like this:

![branch](branch-develop.png)

Earlier we used Git's automatic merge mechanism (Fast forward mode). In this mode, branch information is lost after the branch is deleted. In general, we use the --no-ff parameter when merging branches to disable Fast forward:

```shell
$ git merge --no-ff -m "merge with no-ff" dev
Merge made by the 'recursive' strategy.
 readme.txt | 1 +
 1 file changed, 1 insertion(+)
```

Because this merge needs to create a new commit, add the -m parameter to include the commit description.

After the merge, let's use git log to look at the branch history:

```shell
$ git log --graph --pretty=oneline --abbrev-commit
*   e1e9c68 (HEAD -> master) merge with no-ff
|\
| * f52c633 (dev) add merge
|/
*   cf810e4 conflict fixed
```

As you can see, without the Fast forward mode, the merge looks like this:

![branch](branch-noff.png)

When merging branches, adding the --no-ff parameter allows merging in normal mode. The merged history has branches, so you can tell that a merge was made, whereas a fast forward merge does not show that a merge was ever made.

### Bug Branches

When you receive a task to fix a bug with the code 101, you naturally want to create a branch issue-101 to fix it. But wait: the work currently in progress on dev has not been committed yet:

```shell
$ git status
On branch dev
Changes to be committed:
(use "git reset HEAD <file>..." to unstage)

  new file:   hello.py

Changes not staged for commit:
(use "git add <file>..." to update what will be committed)
(use "git checkout -- <file>..." to discard changes in working directory)

  modified:   readme.txt
```

It is not that you do not want to commit, but the work is only half done and cannot be committed yet. It is estimated that one more day is needed to complete it. However, the bug must be fixed within two hours. What should you do?

Fortunately, Git also provides a stash feature, which can "store" the current work site so that you can continue working after restoring the site later:

```shell
$ git stash
Saved working directory and index state WIP on dev: f52c633 add merge
```

The working directory is clean. Where did the work site just go? Use the git stash list command to see:

```shell
$ git stash list
stash@{0}: WIP on dev: f52c633 add merge
```

Use git stash pop to restore the work site and delete the stash content at the same time:

```shell
$ git stash pop
On branch dev
Changes to be committed:
  (use "git reset HEAD <file>..." to unstage)

    new file:   hello.py

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git checkout -- <file>..." to discard changes in working directory)

    modified:   readme.txt

Dropped refs/stash@{0} (5d677e2ee266f39ea296182fb2354265b91b3b2a)
```

You can stash multiple times. When restoring, first use git stash list to view, and then restore a specified stash with the command:

```shell
$ git stash apply stash@{0}
```

When fixing a bug, we fix it by creating a new bug branch, then merge it, and finally delete it;

When the work at hand is not finished, first git stash the work site, then go to fix the bug. After the fix, run git stash pop to return to the work site.

### Feature Branches

When adding a new feature, you certainly do not want to mess up the main branch with some experimental code. Therefore, for each new feature, it is best to create a new feature branch, develop on it, and after completion, merge it, and finally delete the feature branch.

To develop a new feature, it is best to create a new branch;

If you want to discard a branch that has not been merged, you can force-delete it through git branch -D <name>.

### Collaborating with Multiple People

When you clone from a remote repository, Git automatically maps the local master branch to the remote master branch, and the default name of the remote repository is origin.

To view information about the remote repository, use git remote:

```shell
$ git remote
origin
```

Alternatively, use git remote -v to display more detailed information:

```shell
$ git remote -v
origin  git@github.com:michaelliao/learngit.git (fetch)
origin  git@github.com:michaelliao/learngit.git (push)
```

The above shows the addresses of origin from which you can fetch and to which you can push. If you do not have push permission, you will not see the push address.

The workflow for collaboration among multiple people is usually as follows:

1.  First, try to use git push origin <branch-name> to push your own modifications;

2.  If the push fails, it is because the remote branch is newer than your local one. You need to use git pull first to try to merge;

3.  If there are conflicts during the merge, resolve the conflicts and commit locally;

4.  If there are no conflicts, or after the conflicts are resolved, use git push origin <branch-name> again to push successfully!

If git pull prompts no tracking information, it means that the link between the local branch and the remote branch has not been created. Use the command git branch --set-upstream-to <branch-name> origin/<branch-name>.

This is the workflow for collaboration among multiple people. Once you are familiar with it, it is very simple.

-   To view remote repository information, use git remote -v;

-   A locally created branch is invisible to others if it is not pushed to the remote;

-   To push a branch from local, use git push origin branch-name. If the push fails, use git pull first to fetch the new commits from the remote;

-   To create a branch locally that corresponds to a remote branch, use git checkout -b branch-name origin/branch-name. The local and remote branch names should preferably be consistent;

-   To establish the association between a local branch and a remote branch, use git branch --set-upstream branch-name origin/branch-name;

-   To fetch a branch from the remote, use git pull. If there are conflicts, resolve them first.

### rebase

-   The rebase operation can straighten the forked commit history that has not been pushed locally;

-   The purpose of rebase is to make it easier for us to review the changes in historical commits, because forked commits require a three-way comparison.

## Tag Management

When releasing a version, we usually first create a tag (tag) in the repository, which uniquely determines the version at the moment the tag was created. No matter when in the future, retrieving the version of a certain tag means retrieving the historical version from the moment the tag was created. Therefore, a tag is also a snapshot of the repository.
Although a Git tag is a snapshot of the repository, it is actually a pointer to a commit (it is very similar to a branch, right? But a branch can move, while a tag cannot), so creating and deleting tags is completed instantly.

Git already has commits. Why introduce tags?

"Please package and release the version from last Monday. The commit number is 6a5819e..."

"A bunch of messy numbers is hard to find!"

If we try another approach:

"Please package and release the version from last Monday. The version number is v1.2."

"OK, just look up the commit by tag v1.2!"

Therefore, **a tag is a meaningful name that is easy to remember and is bound to a commit**.

### Creating Tags

Creating a tag in Git is very simple. First, switch to the branch where you want to create the tag:

```shell
$ git branch
* dev
  master
$ git checkout master
Switched to branch 'master'
```

Then, run the command git tag <name> to create a new tag:

```shell
$ git tag v1.0
```

You can use the git tag command to view all tags:

```shell
$ git tag
v1.0
```

To create a tag at any point in time, use git log to find the commit id, and then create the tag:

```shell
$ git tag v0.9 f52c633
```

Note that tags are not listed in chronological order, but in alphabetical order. You can use git show <tagname> to view tag information:

```shell
$ git show v0.9
commit f52c63349bc3c1593499807e5c8e972b82c8f286 (tag: v0.9)
Author: Michael Liao <askxuefeng@gmail.com>
Date:   Fri May 18 21:56:54 2018 +0800

    add merge

diff --git a/readme.txt b/readme.txt
```

### Operating on Tags

If you create a tag by mistake, you can also delete it:

```shell
$ git tag -d v0.1
Deleted tag 'v0.1' (was f15b0dd)
```

To push a tag to the remote, use the command git push origin <tagname>:

```shell
$ git push origin v1.0
Total 0 (delta 0), reused 0 (delta 0)
To github.com:michaelliao/learngit.git
 * [new tag]         v1.0 -> v1.0
```

Alternatively, push all local tags that have not yet been pushed to the remote at once:
``` shell
$ git push origin --tags
Total 0 (delta 0), reused 0 (delta 0)
To github.com:michaelliao/learngit.git
 * [new tag]         v0.9 -> v0.9
```
If a tag has already been pushed to the remote, deleting the remote tag is a bit more troublesome. First delete it locally:
``` shell
$ git tag -d v0.9
Deleted tag 'v0.9' (was f52c633)
```
Then delete it from the remote. The delete command is also push, but in the following format:
``` shell
$ git push origin :refs/tags/v0.9
To github.com:michaelliao/learngit.git
 - [deleted]         v0.9
```
