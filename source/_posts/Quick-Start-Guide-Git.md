---
title: Quick Start Guide Git
date: 2018-07-12 07:01:31
tags:
- Quick Start Guide
- Git
---

## Git介绍

Git是目前世界上最先进的**分布式**版本控制系统（没有之一）。

### 集中式vs分布式区别

-   集中式网络拓扑图
    ![集中式拓扑图](集中式.PNG)
-   分布式拓扑图
    ![分布式拓扑图](分布式.PNG)

## Git 安装

### linux上安装

```shell
$ sudo apt-get install git
```

### windows上安装

在Windows上使用Git，可以从[官网](https://git-scm.com/downloads)直接下载安装程序，（网速慢的同学请从[国内镜像](https://pan.baidu.com/s/1kU5OCOB#list/path=%2Fpub%2Fgit)）下载，然后按默认选项安装即可。

安装完成后，在开始菜单里找到“Git”->“Git Bash”，蹦出一个类似命令行窗口的东西，就说明Git安装成功！

安装完成后，还需要最后一步设置，在命令行输入：

```shell
$ git config --global user.name "Your Name"
$ git config --global user.email "email@example.com"
```

因为Git是分布式版本控制系统，所以，每个机器都必须自报家门：你的名字和Email地址。你也许会担心，如果有人故意冒充别人怎么办？这个不必担心，首先我们相信大家都是善良无知的群众，其次，真的有冒充的也是有办法可查的。

注意git config命令的--global参数，用了这个参数，表示你这台机器上所有的Git仓库都会使用这个配置，当然也可以对某个仓库指定不同的用户名和Email地址。

## 创建版本库

首先，选择一个合适的地方，创建一个空目录：

```shell
$ mkdir learngit
$ cd learngit
$ pwd
/Users/wlb/learngit
```

第二步，通过git init命令把这个目录变成Git可以管理的仓库：

```shell
$ git init
Initialized empty Git repository in /Users/wlb/learngit/.git/
```

### 把文件添加到版本库

现在我们编写一个readme.txt文件，内容如下

```text
Git is a version control system.
Git is free software.
```

第一步，用命令git add告诉Git，把文件添加到仓库：

```shell
$ git add readme.txt
```

第二步，用命令git commit告诉Git，把文件提交到仓库：

```shell
$ git commit -m "wrote a readme file"
[master (root-commit) eaadf4e] wrote a readme file
 1 file changed, 2 insertions(+)
 create mode 100644 readme.txt
```

## 版本管理

我们已经成功地添加并提交了一个readme.txt文件，现在，是时候继续工作了，于是，我们继续修改readme.txt文件，改成如下内容：

```text
Git is a "distributed" version control system.
Git is free software.
```

现在，运行git status命令看看结果：

```shell
$ git status
On branch master
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git checkout -- <file>..." to discard changes in working directory)

    modified:   readme.txt

no changes added to commit (use "git add" and/or "git commit -a")
```

想查看具体改动哪些内容，需要用git diff这个命令看看

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

添加提交修改的文件

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

### 版本回退

再次修改readme.txt文件如下：

```text
Git is a distributed version control system.
Git is free software distributed under the GPL
```

然后尝试提交：

```shell
$ git add readme.txt
$ git commit -m "append GPL"
[master 1094adb] append GPL
 1 file changed, 1 insertion(+), 1 deletion(-)
```

现在，我们回顾一下readme.txt文件一共有几个版本被提交到Git仓库里了：
版本1：wrote a readme file

```text
Git is a version control system.
Git is free software
```

版本2：add distributed

```text
Git is a distributed version control system.
Git is free software.
```

版本3：append GPL

```text
Git is a distributed version control system.
Git is free software distributed under the GPL.
```

在实际工作中,我们用git log --pretty=oneline命令查看每次提交的改动--pretty=oneline精简格式（可选）

```shell
$ git log --pretty=oneline
1094adb7b9b3807259d8cb349e7df1d4d6477073 (HEAD -> master) append GPL
e475afc93c209a690c39c13a46716e8fa000c366 add distributed
eaadf4e385e865d25c48e7ca9c8395c3f7dfaef0 wrote a readme file
```

现在如果准备把readme.txt回退到上一个版本，也就是add distributed的那个版本，怎么做呢？
先看下git回退的原理，Git的版本回退速度非常快，因为Git在内部有个指向当前版本的HEAD指针，当你回退版本的时候，Git仅仅是把HEAD从指向append GPL,改为指向add distributed：

![head指针](head.jpg)
![head2指针](head2.jpg)

我们可以通过git reset --hard命令实现版本回退

```shell
$ git reset --hard HEAD^
HEAD is now at e475afc add distributed
```

HEAD表示当前版本，上一个版本就是HEAD^，上上一个版本就是HEAD^^ ，上100个版本HEAD~100，当然也可以直接通过commit id来回退到对应的版本

```shell
$ git reset --hard 1094a
HEAD is now at 83b0afe append GPL
```

只要有commit id 指针可以切换到任意版本，无论是回退还是恢复，有时由于回退到上一个版本后无法得之回退前的commit id，想要还原回来我们需要通过git reflog命令查找回退前的commit id

```shell
$ git reflog
e475afc HEAD@{1}: reset: moving to HEAD^
1094adb (HEAD -> master) HEAD@{2}: commit: append GPL
e475afc HEAD@{3}: commit: add distributed
eaadf4e HEAD@{4}: commit (initial): wrote a readme file
```

如果还没有建议登陆到git服务器（在本地修改还没push的前提下）查看对应版本的commit id

### 工作区和暂存区

工作区：就是你在电脑里能看到的目录，比如我的learngit文件夹就是一个工作区(隐藏目录.git不属于工作区)
版本库：工作区有一个隐藏目录.git，这个就是Git的版本库。版本库包括 stage(暂存区)、master(分支)、head(指向master的指针)
暂存区：版本库中的stage(或者叫index)部分。
三者关系如图所示：

![工作区和暂存区](workandstage.jpg)

第一步是用git add把工作区的文件修(创建新文件也属于文件修改)改添加到stage中进去，实际上就是把件修改添加到暂存区；
第二步是用git commit提交更改，实际上就是把暂存区的所有内容提交到当前分支。

### 管理修改

Git管理的是修改，当你用git add命令后，在工作区的第一次修改被放入暂存区，准备提交，但是，在工作区的第二次修改并没有放入暂存区，所以，git commit只负责把暂存区的修改提交了，也就是第一次的修改被提交了，第二次的修改不会被提交。

那怎么提交第二次修改呢？你可以继续git add再git commit，也可以别着急提交第一次修改，先git add第二次修改，再git commit，就相当于把两次修改合并后一块提交了：

第一次修改 -> git add -> 第二次修改 -> git add -> git commit

总结：每次修改，如果不用git add到暂存区，那就不会加入到commit中。

### 撤销修改

让我们看看撤销修改应用的几个场景：
场景1：当你改乱了工作区某个文件的内容，想直接丢弃工作区的修改时，用命令git checkout -- file。

场景2：当你不但改乱了工作区某个文件的内容，还添加到了暂存区时，想丢弃修改，分两步，第一步用命令git reset HEAD <file>，就回到了场景1，第二步按场景1操作。

场景3：已经提交了不合适的修改到版本库时，想要撤销本次提交，参考版本回退一节，不过前提是没有推送到远程库。
![撤销修改](撤销修改.png)
看图理解：
场景1: 相当于工作区(unstage changes)撤销修改
场景2: 相当于staged changes 撤销到unstage changes 然后在执行场景1，
场景3：有两种情况，
1.完全撤销Git reset --hard "commit-id" 工作区的改动全部撤销。有的改动不想撤销时这个命令是致命的。
2.安全撤销git reset --soft HEAD^相当于图中的undo只撤回当时提交，而不影响现在工作区的改动

### 删除文件

删除文件有两种情况：
一是确实要从版本库中删除该文件，那就用命令git rm删掉，并且git commit：

```shell
$ git rm test.txt
rm 'test.txt'

$ git commit -m "remove test.txt"
[master d46f35e] remove test.txt
 1 file changed, 1 deletion(-)
 delete mode 100644 test.txt
```

另一种情况是删错了，因为版本库里还有呢，所以可以很轻松地把误删的文件恢复到最新版本：

```shell
$ git checkout -- test.txt
```

## 远程仓库

请自行注册GitHub账号。由于你的本地Git仓库和GitHub仓库之间的传输是通过SSH加密的，所以，需要一点设置：

第1步：创建SSH Key。在用户主目录下，看看有没有.ssh目录，如果有，再看看这个目录下有没有id_rsa和id_rsa.pub这两个文件，如果已经有了，可直接跳到下一步。如果没有，打开Shell（Windows下打开Git Bash），创建SSH Key：

```shell
$ ssh-keygen -t rsa -C "youremail@example.com"
```

你需要把邮件地址换成你自己的邮件地址，然后一路回车，使用默认值即可，由于这个Key也不是用于军事目的，所以也无需设置密码。

如果一切顺利的话，可以在用户主目录里找到.ssh目录，里面有id_rsa和id_rsa.pub两个文件，这两个就是SSH Key的秘钥对，id_rsa是私钥，不能泄露出去，id_rsa.pub是公钥，可以放心地告诉任何人。

第2步：登陆GitHub，打开“Account settings”，“SSH Keys”页面：

然后，点“Add SSH Key”，填上任意Title，在Key文本框里粘贴id_rsa.pub文件的内容：

![githubssh](githubssh.png)

### 添加远程库

首先，登陆GitHub，然后，在右上角找到“Create a new repo”按钮，创建一个新的仓库 learngit：

目前，在GitHub上的这个learngit仓库还是空的，GitHub告诉我们，**可以从这个仓库克隆出新的仓库，也可以把一个已有的本地仓库与之关联**，然后，把本地仓库的内容推送到GitHub仓库。

由于我们在本地初始化的版本库所以我们用第二种方式关联远程库：

```shell
$ git remote add origin git@github.com:whiteleibniz/learngit.git
```

下一步，就可以把本地库的所有内容推送到远程库上：

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

由于远程库是空的，我们第一次推送master分支时，加上了-u参数，Git不但会把本地的master分支内容推送的远程新的master分支，还会把本地的master分支和远程的master分支关联起来，在以后的推送或者拉取时就可以简化命令。

### 从远程库克隆

上次我们讲了先有本地库，后有远程库的时候，如何关联远程库。

现在，假设我们从零开发，那么最好的方式是先创建远程库，然后，从远程库克隆。

首先，登陆GitHub，创建一个新的仓库，名字叫gitskills：

远程库已经准备好了，下一步是用命令git clone克隆一个本地库：

```shell
$ git clone git@github.com:whiteleibniz/gitskills.git
Cloning into 'gitskills'...
remote: Counting objects: 3, done.
remote: Total 3 (delta 0), reused 0 (delta 0), pack-reused 3
Receiving objects: 100% (3/3), done.
```

## 分支管理

分支就是科幻电影里面的平行宇宙，当你正在电脑前努力学习Git的时候，另一个你正在另一个平行宇宙里努力学习SVN。

如果两个平行宇宙互不干扰，那对现在的你也没啥影响。不过，在某个时间点，两个平行宇宙合并了，结果，你既学会了Git又学会了SVN！

![branch](branch.png)

分支在实际中有什么用呢？假设你准备开发一个新功能，但是需要两周才能完成，第一周你写了50%的代码，如果立刻提交，由于代码还没写完，不完整的代码库会导致别人不能干活了。如果等代码全部写完再一次提交，又存在丢失每天进度的巨大风险。

现在有了分支，就不用怕了。你创建了一个属于你自己的分支，别人看不到，还继续在原来的分支上正常工作，而你在自己的分支上干活，想提交就提交，直到开发完毕后，再一次性合并到原来的分支上，这样，既安全，又不影响别人工作。

其他版本控制系统如SVN等都有分支管理，但是用过之后你会发现，这些版本控制系统创建和切换分支比蜗牛还慢，简直让人无法忍受，结果分支功能成了摆设，大家都不去用。

但Git的分支是与众不同的，无论创建、切换和删除分支，Git在1秒钟之内就能完成！无论你的版本库是1个文件还是1万个文件。

### 创建与合并分支

创建分支本质上是在原有分支的上某时间点的提交上新建一个指向该提交的指针，然后在将HEAD指针指向该分支指针，原理如下图：
创建分支：
![branch](branch-dev.png)
分支提交:
![branch](branch-commit.png)
分支合并: git merge命令用于合并**指定分支到当前分支**。
![branch](branch-merge.png)
删除分支：合并后分支基本没用了可以删除掉，删除分支就是把分支指针给删掉
![branch](branch-del.png)

分支操作常用命令：

查看分支：git branch

创建分支：git branch  &lt;name>

切换分支：git checkout  &lt;name>

创建+切换分支：git checkout -b  &lt;name>

合并某分支到当前分支：git merge  &lt;name>

删除分支：git branch -d  &lt;name>

### 解决冲突

冲突产生的原因以及如何解决冲突：
在主分支和分支中同时对一个文件进行了修改并且都commit了，这时git无法进行自动合并，需要把git合并失败的文件手动编辑为我们希望的内容。

执行合并命令时git给出的提示：

```shell
$ git merge feature1
Auto-merging readme.txt
CONFLICT (content): Merge conflict in readme.txt
Automatic merge failed; fix conflicts and then commit the result.
```

使用git status 查看冲突的具体原因：

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

查看冲突文件readme的内容：

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

Git用&lt;&lt;&lt;&lt;&lt;&lt;&lt;，=======，>>>>>>>标记出不同分支的内容，我们修改如下后保存：

```shell
Creating a new branch is quick and simple.
```

执行提交：

```shell
$ git add readme.txt
$ git commit -m "conflict fixed"
[master cf810e4] conflict fixed
```

### 分支管理策略

在实际开发中，我们应该按照几个基本原则进行分支管理：

首先，master分支应该是非常稳定的，也就是仅用来发布新版本，平时不能在上面干活；

那在哪干活呢？干活都在dev分支上，也就是说，dev分支是不稳定的，到某个时候，比如1.0版本发布时，再把dev分支合并到master上，在master分支发布1.0版本；

你和你的小伙伴们每个人都在dev分支上干活，每个人都有自己的分支，时不时地往dev分支上合并就可以了。

所以，团队合作的分支看起来就像这样：

![branch](branch-develop.png)

前面我们使用了git自动合并机制(Fast forward模式),在这种模式下，删除分支后，会丢掉分支信息。一般情况下我们在合并分支时使用 --no-ff 参数来禁用Fast forward

```shell
$ git merge --no-ff -m "merge with no-ff" dev
Merge made by the 'recursive' strategy.
 readme.txt | 1 +
 1 file changed, 1 insertion(+)
```

 因为本次合并要创建一个新的commit，所以加上-m参数，把commit描述写进去。

合并后，我们用git log看看分支历史：

```shell
$ git log --graph --pretty=oneline --abbrev-commit
*   e1e9c68 (HEAD -> master) merge with no-ff
|\
| * f52c633 (dev) add merge
|/
*   cf810e4 conflict fixed
```

可以看到，不使用Fast forward模式，merge后就像这样：

![branch](branch-noff.png)

合并分支时，加上--no-ff参数就可以用普通模式合并，合并后的历史有分支，能看出来曾经做过合并，而fast forward合并就看不出来曾经做过合并。

### Bug分支

当你接到一个修复一个代号101的bug的任务时，很自然地，你想创建一个分支issue-101来修复它，但是，等等，当前正在dev上进行的工作还没有提交：

``` shell
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
并不是你不想提交，而是工作只进行到一半，还没法提交，预计完成还需1天时间。但是，必须在两个小时内修复该bug，怎么办？

幸好，Git还提供了一个stash功能，可以把当前工作现场“储藏”起来，等以后恢复现场后继续工作：
``` shell
$ git stash
Saved working directory and index state WIP on dev: f52c633 add merge
```
