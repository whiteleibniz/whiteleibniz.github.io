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
``` shell
$ git reset --hard HEAD^
HEAD is now at e475afc add distributed
```
HEAD表示当前版本，上一个版本就是HEAD^，上上一个版本就是HEAD^^ ，上100个版本HEAD~100，当然也可以直接通过commit id来回退到对应的版本
``` shell
$ git reset --hard 1094a
HEAD is now at 83b0afe append GPL
```
只要有commit id 指针可以切换到任意版本，无论是回退还是恢复，有时由于回退到上一个版本后无法得之回退前的commit id，想要还原回来我们需要通过git reflog命令查找回退前的commit id
``` shell
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
