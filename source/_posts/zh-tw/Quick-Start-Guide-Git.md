---
title: Quick Start Guide Git
date: 2018-07-12 07:01:31
lang: zh-TW
tags:
- Quick Start Guide
- Git
typora-root-url: Quick-Start-Guide-Git
permalink: zh-tw/2018/07/12/Quick-Start-Guide-Git/
---
## Git 常用命令檢索
 ![git-command](git-command.PNG)
## Git介紹

Git是目前世界上最先進的**分佈式**版本控制系統（沒有之一）。

### 集中式vs分佈式區別

-   集中式網絡拓撲圖
    ![集中式拓撲圖](集中式.PNG)
-   分佈式拓撲圖
    ![分佈式拓撲圖](分佈式.PNG)

## Git 安裝

### linux上安裝

```shell
$ sudo apt-get install git
```

### windows上安裝

在Windows上使用Git，可以從[官網](https://git-scm.com/downloads)直接下載安裝程序，（網速慢的同學請從[國內鏡像](https://pan.baidu.com/s/1kU5OCOB#list/path=%2Fpub%2Fgit)）下載，然後按默認選項安裝即可。

安裝完成後，在開始菜單裡找到“Git”->“Git Bash”，蹦出一個類似命令行窗口的東西，就說明Git安裝成功！

安裝完成後，還需要最後一步設置，在命令行輸入：

```shell
$ git config --global user.name "Your Name"
$ git config --global user.email "email@example.com"
```

因為Git是分佈式版本控制系統，所以，每個機器都必須自報家門：你的名字和Email地址。你也許會擔心，如果有人故意冒充別人怎麼辦？這個不必擔心，首先我們相信大家都是善良無知的群眾，其次，真的有冒充的也是有辦法可查的。

注意git config命令的--global參數，用了這個參數，表示你這臺機器上所有的Git倉庫都會使用這個配置，當然也可以對某個倉庫指定不同的用戶名和Email地址。

## 創建版本庫

首先，選擇一個合適的地方，創建一個空目錄：

```shell
$ mkdir learngit
$ cd learngit
$ pwd
/Users/wlb/learngit
```

第二步，通過git init命令把這個目錄變成Git可以管理的倉庫：

```shell
$ git init
Initialized empty Git repository in /Users/wlb/learngit/.git/
```

### 把文件添加到版本庫

現在我們編寫一個readme.txt文件，內容如下

```text
Git is a version control system.
Git is free software.
```

第一步，用命令git add告訴Git，把文件添加到倉庫：

```shell
$ git add readme.txt
```

第二步，用命令git commit告訴Git，把文件提交到倉庫：

```shell
$ git commit -m "wrote a readme file"
[master (root-commit) eaadf4e] wrote a readme file
 1 file changed, 2 insertions(+)
 create mode 100644 readme.txt
```

## 版本管理

我們已經成功地添加並提交了一個readme.txt文件，現在，是時候繼續工作了，於是，我們繼續修改readme.txt文件，改成如下內容：

```text
Git is a "distributed" version control system.
Git is free software.
```

現在，運行git status命令看看結果：

```shell
$ git status
On branch master
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git checkout -- <file>..." to discard changes in working directory)

    modified:   readme.txt

no changes added to commit (use "git add" and/or "git commit -a")
```

想查看具體改動哪些內容，需要用git diff這個命令看看

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

然後嘗試提交：

```shell
$ git add readme.txt
$ git commit -m "append GPL"
[master 1094adb] append GPL
 1 file changed, 1 insertion(+), 1 deletion(-)
```

現在，我們回顧一下readme.txt文件一共有幾個版本被提交到Git倉庫裡了：
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

在實際工作中,我們用git log --pretty=oneline命令查看每次提交的改動--pretty=oneline精簡格式（可選）

```shell
$ git log --pretty=oneline
1094adb7b9b3807259d8cb349e7df1d4d6477073 (HEAD -> master) append GPL
e475afc93c209a690c39c13a46716e8fa000c366 add distributed
eaadf4e385e865d25c48e7ca9c8395c3f7dfaef0 wrote a readme file
```

現在如果準備把readme.txt回退到上一個版本，也就是add distributed的那個版本，怎麼做呢？
先看下git回退的原理，Git的版本回退速度非常快，因為Git在內部有個指向當前版本的HEAD指針，當你回退版本的時候，Git僅僅是把HEAD從指向append GPL,改為指向add distributed：

![head指針](head.jpg)
![head2指針](head2.jpg)

我們可以通過git reset --hard命令實現版本回退

```shell
$ git reset --hard HEAD^
HEAD is now at e475afc add distributed
```

HEAD表示當前版本，上一個版本就是HEAD^，上上一個版本就是HEAD^^ ，上100個版本HEAD~100，當然也可以直接通過commit id來回退到對應的版本

```shell
$ git reset --hard 1094a
HEAD is now at 83b0afe append GPL
```

只要有commit id 指針可以切換到任意版本，無論是回退還是恢復，有時由於回退到上一個版本後無法得之回退前的commit id，想要還原回來我們需要通過git reflog命令查找回退前的commit id

```shell
$ git reflog
e475afc HEAD@{1}: reset: moving to HEAD^
1094adb (HEAD -> master) HEAD@{2}: commit: append GPL
e475afc HEAD@{3}: commit: add distributed
eaadf4e HEAD@{4}: commit (initial): wrote a readme file
```

如果還沒有建議登陸到git服務器（在本地修改還沒push的前提下）查看對應版本的commit id

### 工作區和暫存區

工作區：就是你在電腦裡能看到的目錄，比如我的learngit文件夾就是一個工作區(隱藏目錄.git不屬於工作區)
版本庫：工作區有一個隱藏目錄.git，這個就是Git的版本庫。版本庫包括 stage(暫存區)、master(分支)、head(指向master的指針)
暫存區：版本庫中的stage(或者叫index)部分。
三者關係如圖所示：

![工作區和暫存區](workandstage.jpg)

第一步是用git add把工作區的文件修(創建新文件也屬於文件修改)改添加到stage中進去，實際上就是把件修改添加到暫存區；
第二步是用git commit提交更改，實際上就是把暫存區的所有內容提交到當前分支。

### 管理修改

Git管理的是修改，當你用git add命令後，在工作區的第一次修改被放入暫存區，準備提交，但是，在工作區的第二次修改並沒有放入暫存區，所以，git commit只負責把暫存區的修改提交了，也就是第一次的修改被提交了，第二次的修改不會被提交。

那怎麼提交第二次修改呢？你可以繼續git add再git commit，也可以彆著急提交第一次修改，先git add第二次修改，再git commit，就相當於把兩次修改合併後一塊提交了：

第一次修改 -> git add -> 第二次修改 -> git add -> git commit

總結：每次修改，如果不用git add到暫存區，那就不會加入到commit中。

### 撤銷修改

讓我們看看撤銷修改應用的幾個場景：
場景1：當你改亂了工作區某個文件的內容，想直接丟棄工作區的修改時，用命令git checkout -- file。

場景2：當你不但改亂了工作區某個文件的內容，還添加到了暫存區時，想丟棄修改，分兩步，第一步用命令git reset HEAD <file>，就回到了場景1，第二步按場景1操作。

場景3：已經提交了不合適的修改到版本庫時，想要撤銷本次提交，參考版本回退一節，不過前提是沒有推送到遠程庫。
![撤銷修改](撤銷修改.png)
看圖理解：
場景1: 相當於工作區(unstage changes)撤銷修改
場景2: 相當於staged changes 撤銷到unstage changes 然後在執行場景1，
場景3：有兩種情況，
1.完全撤銷Git reset --hard "commit-id" 工作區的改動全部撤銷。有的改動不想撤銷時這個命令是致命的。
2.安全撤銷git reset --soft HEAD^相當於圖中的undo只撤回當時提交，而不影響現在工作區的改動

### 刪除文件

刪除文件有兩種情況：
一是確實要從版本庫中刪除該文件，那就用命令git rm刪掉，並且git commit：

```shell
$ git rm test.txt
rm 'test.txt'

$ git commit -m "remove test.txt"
[master d46f35e] remove test.txt
 1 file changed, 1 deletion(-)
 delete mode 100644 test.txt
```

另一種情況是刪錯了，因為版本庫裡還有呢，所以可以很輕鬆地把誤刪的文件恢復到最新版本：

```shell
$ git checkout -- test.txt
```

## 遠程倉庫

請自行註冊GitHub賬號。由於你的本地Git倉庫和GitHub倉庫之間的傳輸是通過SSH加密的，所以，需要一點設置：

第1步：創建SSH Key。在用戶主目錄下，看看有沒有.ssh目錄，如果有，再看看這個目錄下有沒有id_rsa和id_rsa.pub這兩個文件，如果已經有了，可直接跳到下一步。如果沒有，打開Shell（Windows下打開Git Bash），創建SSH Key：

```shell
$ ssh-keygen -t rsa -C "youremail@example.com"
```

你需要把郵件地址換成你自己的郵件地址，然後一路回車，使用默認值即可，由於這個Key也不是用於軍事目的，所以也無需設置密碼。

如果一切順利的話，可以在用戶主目錄裡找到.ssh目錄，裡面有id_rsa和id_rsa.pub兩個文件，這兩個就是SSH Key的秘鑰對，id_rsa是私鑰，不能洩露出去，id_rsa.pub是公鑰，可以放心地告訴任何人。

第2步：登陸GitHub，打開“Account settings”，“SSH Keys”頁面：

然後，點“Add SSH Key”，填上任意Title，在Key文本框裡粘貼id_rsa.pub文件的內容：

![githubssh](githubssh.png)

### 添加遠程庫

首先，登陸GitHub，然後，在右上角找到“Create a new repo”按鈕，創建一個新的倉庫 learngit：

目前，在GitHub上的這個learngit倉庫還是空的，GitHub告訴我們，**可以從這個倉庫克隆出新的倉庫，也可以把一個已有的本地倉庫與之關聯**，然後，把本地倉庫的內容推送到GitHub倉庫。

由於我們在本地初始化的版本庫所以我們用第二種方式關聯遠程庫：

```shell
$ git remote add origin git@github.com:whiteleibniz/learngit.git
```

下一步，就可以把本地庫的所有內容推送到遠程庫上：

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

由於遠程庫是空的，我們第一次推送master分支時，加上了-u參數，Git不但會把本地的master分支內容推送的遠程新的master分支，還會把本地的master分支和遠程的master分支關聯起來，在以後的推送或者拉取時就可以簡化命令。

### 從遠程庫克隆

上次我們講了先有本地庫，後有遠程庫的時候，如何關聯遠程庫。

現在，假設我們從零開發，那麼最好的方式是先創建遠程庫，然後，從遠程庫克隆。

首先，登陸GitHub，創建一個新的倉庫，名字叫gitskills：

遠程庫已經準備好了，下一步是用命令git clone克隆一個本地庫：

```shell
$ git clone git@github.com:whiteleibniz/gitskills.git
Cloning into 'gitskills'...
remote: Counting objects: 3, done.
remote: Total 3 (delta 0), reused 0 (delta 0), pack-reused 3
Receiving objects: 100% (3/3), done.
```

## 分支管理

分支就是科幻電影裡面的平行宇宙，當你正在電腦前努力學習Git的時候，另一個你正在另一個平行宇宙裡努力學習SVN。

如果兩個平行宇宙互不干擾，那對現在的你也沒啥影響。不過，在某個時間點，兩個平行宇宙合併了，結果，你既學會了Git又學會了SVN！

![branch](branch.png)

分支在實際中有什麼用呢？假設你準備開發一個新功能，但是需要兩週才能完成，第一週你寫了50%的代碼，如果立刻提交，由於代碼還沒寫完，不完整的代碼庫會導致別人不能幹活了。如果等代碼全部寫完再一次提交，又存在丟失每天進度的巨大風險。

現在有了分支，就不用怕了。你創建了一個屬於你自己的分支，別人看不到，還繼續在原來的分支上正常工作，而你在自己的分支上幹活，想提交就提交，直到開發完畢後，再一次性合併到原來的分支上，這樣，既安全，又不影響別人工作。

其他版本控制系統如SVN等都有分支管理，但是用過之後你會發現，這些版本控制系統創建和切換分支比蝸牛還慢，簡直讓人無法忍受，結果分支功能成了擺設，大家都不去用。

但Git的分支是與眾不同的，無論創建、切換和刪除分支，Git在1秒鐘之內就能完成！無論你的版本庫是1個文件還是1萬個文件。

### 創建與合併分支

創建分支本質上是在原有分支的上某時間點的提交上新建一個指向該提交的指針，然後在將HEAD指針指向該分支指針，原理如下圖：
創建分支：
![branch](branch-dev.png)
分支提交:
![branch](branch-commit.png)
分支合併: git merge命令用於合併**指定分支到當前分支**。
![branch](branch-merge.png)
刪除分支：合併後分支基本沒用了可以刪除掉，刪除分支就是把分支指針給刪掉
![branch](branch-del.png)

分支操作常用命令：

查看分支：git branch

創建分支：git branch  &lt;name>

切換分支：git checkout  &lt;name>

創建+切換分支：git checkout -b  &lt;name>

合併某分支到當前分支：git merge  &lt;name>

刪除分支：git branch -d  &lt;name>

### 解決衝突

衝突產生的原因以及如何解決衝突：
在主分支和分支中同時對一個文件進行了修改並且都commit了，這時git無法進行自動合併，需要把git合併失敗的文件手動編輯為我們希望的內容。

執行合併命令時git給出的提示：

```shell
$ git merge feature1
Auto-merging readme.txt
CONFLICT (content): Merge conflict in readme.txt
Automatic merge failed; fix conflicts and then commit the result.
```

使用git status 查看衝突的具體原因：

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

查看衝突文件readme的內容：

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

Git用&lt;&lt;&lt;&lt;&lt;&lt;&lt;，=======，>>>>>>>標記出不同分支的內容，我們修改如下後保存：

```shell
Creating a new branch is quick and simple.
```

執行提交：

```shell
$ git add readme.txt
$ git commit -m "conflict fixed"
[master cf810e4] conflict fixed
```

### 分支管理策略

在實際開發中，我們應該按照幾個基本原則進行分支管理：

首先，master分支應該是非常穩定的，也就是僅用來發布新版本，平時不能在上面幹活；

那在哪幹活呢？幹活都在dev分支上，也就是說，dev分支是不穩定的，到某個時候，比如1.0版本發佈時，再把dev分支合併到master上，在master分支發佈1.0版本；

你和你的小夥伴們每個人都在dev分支上幹活，每個人都有自己的分支，時不時地往dev分支上合併就可以了。

所以，團隊合作的分支看起來就像這樣：

![branch](branch-develop.png)

前面我們使用了git自動合併機制(Fast forward模式),在這種模式下，刪除分支後，會丟掉分支信息。一般情況下我們在合併分支時使用 --no-ff 參數來禁用Fast forward

```shell
$ git merge --no-ff -m "merge with no-ff" dev
Merge made by the 'recursive' strategy.
 readme.txt | 1 +
 1 file changed, 1 insertion(+)
```

 因為本次合併要創建一個新的commit，所以加上-m參數，把commit描述寫進去。

合併後，我們用git log看看分支歷史：

```shell
$ git log --graph --pretty=oneline --abbrev-commit
*   e1e9c68 (HEAD -> master) merge with no-ff
|\
| * f52c633 (dev) add merge
|/
*   cf810e4 conflict fixed
```

可以看到，不使用Fast forward模式，merge後就像這樣：

![branch](branch-noff.png)

合併分支時，加上--no-ff參數就可以用普通模式合併，合併後的歷史有分支，能看出來曾經做過合併，而fast forward合併就看不出來曾經做過合併。

### Bug分支

當你接到一個修復一個代號101的bug的任務時，很自然地，你想創建一個分支issue-101來修復它，但是，等等，當前正在dev上進行的工作還沒有提交：

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

並不是你不想提交，而是工作只進行到一半，還沒法提交，預計完成還需1天時間。但是，必須在兩個小時內修復該bug，怎麼辦？

幸好，Git還提供了一個stash功能，可以把當前工作現場“儲藏”起來，等以後恢復現場後繼續工作：

```shell
$ git stash
Saved working directory and index state WIP on dev: f52c633 add merge
```

工作區是乾淨的，剛才的工作現場存到哪去了？用git stash list命令看看：

```shell
$ git stash list
stash@{0}: WIP on dev: f52c633 add merge
```

用git stash pop，恢復的同時把stash內容也刪了：

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

你可以多次stash，恢復的時候，先用git stash list查看，然後恢復指定的stash，用命令：

```shell
$ git stash apply stash@{0}
```

修復bug時，我們會通過創建新的bug分支進行修復，然後合併，最後刪除；

當手頭工作沒有完成時，先把工作現場git stash一下，然後去修復bug，修復後，再git stash pop，回到工作現場。

### Feature分支

添加一個新功能時，你肯定不希望因為一些實驗性質的代碼，把主分支搞亂了，所以，每添加一個新功能，最好新建一個feature分支，在上面開發，完成後，合併，最後，刪除該feature分支。

開發一個新feature，最好新建一個分支；

如果要丟棄一個沒有被合併過的分支，可以通過git branch -D &lt;name>強行刪除。

### 多人協作

當你從遠程倉庫克隆時，實際上Git自動把本地的master分支和遠程的master分支對應起來了，並且，遠程倉庫的默認名稱是origin。

要查看遠程庫的信息，用git remote：

```shell
$ git remote
origin
```

或者，用git remote -v顯示更詳細的信息：

```shell
$ git remote -v
origin  git@github.com:michaelliao/learngit.git (fetch)
origin  git@github.com:michaelliao/learngit.git (push)
```

上面顯示了可以抓取和推送的origin的地址。如果沒有推送權限，就看不到push的地址。

多人協作的工作模式通常是這樣：

1.  首先，可以試圖用git push origin &lt;branch-name>推送自己的修改；

2.  如果推送失敗，則因為遠程分支比你的本地更新，需要先用git pull試圖合併；

3.  如果合併有衝突，則解決衝突，並在本地提交；

4.  沒有衝突或者解決掉衝突後，再用git push origin &lt;branch-name>推送就能成功！

如果git pull提示no tracking information，則說明本地分支和遠程分支的鏈接關係沒有創建，用命令git branch --set-upstream-to &lt;branch-name> origin/&lt;branch-name>。

這就是多人協作的工作模式，一旦熟悉了，就非常簡單。

-   查看遠程庫信息，使用git remote -v；

-   本地新建的分支如果不推送到遠程，對其他人就是不可見的；

-   從本地推送分支，使用git push origin branch-name，如果推送失敗，先用git pull抓取遠程的新提交；

-   在本地創建和遠程分支對應的分支，使用git checkout -b branch-name origin/branch-name，本地和遠程分支的名稱最好一致；

-   建立本地分支和遠程分支的關聯，使用git branch --set-upstream branch-name origin/branch-name；

-   從遠程抓取分支，使用git pull，如果有衝突，要先處理衝突。

### rebase

-   rebase操作可以把本地未push的分叉提交歷史整理成直線；
-   rebase的目的是使得我們在查看歷史提交的變化時更容易，因為分叉的提交需要三方對比。

## 標籤管理

發佈一個版本時，我們通常先在版本庫中打一個標籤（tag），這樣，就唯一確定了打標籤時刻的版本。將來無論什麼時候，取某個標籤的版本，就是把那個打標籤的時刻的歷史版本取出來。所以，標籤也是版本庫的一個快照。
Git的標籤雖然是版本庫的快照，但其實它就是指向某個commit的指針（跟分支很像對不對？但是分支可以移動，標籤不能移動），所以，創建和刪除標籤都是瞬間完成的。

Git有commit，為什麼還要引入tag？

“請把上週一的那個版本打包發佈，commit號是6a5819e...”

“一串亂七八糟的數字不好找！”

如果換一個辦法：

“請把上週一的那個版本打包發佈，版本號是v1.2”

“好的，按照tag v1.2查找commit就行！”

所以，**tag就是一個讓人容易記住的有意義的名字，它跟某個commit綁在一起**。

### 創建標籤

在Git中打標籤非常簡單，首先，切換到需要打標籤的分支上：

```shell
$ git branch
* dev
  master
$ git checkout master
Switched to branch 'master'
```

然後，敲命令git tag &lt;name>就可以打一個新標籤：

```shell
$ git tag v1.0
```

可以用命令git tag查看所有標籤：

```shell
$ git tag
v1.0
```

在任意時間點打標籤git log找到commit id，然後打上就可以了：

```shell
$ git tag v0.9 f52c633
```

注意，標籤不是按時間順序列出，而是按字母排序的。可以用git show &lt;tagname>查看標籤信息：

```shell
$ git show v0.9
commit f52c63349bc3c1593499807e5c8e972b82c8f286 (tag: v0.9)
Author: Michael Liao <askxuefeng@gmail.com>
Date:   Fri May 18 21:56:54 2018 +0800

    add merge

diff --git a/readme.txt b/readme.txt
```

### 操作標籤

如果標籤打錯了，也可以刪除：

```shell
$ git tag -d v0.1
Deleted tag 'v0.1' (was f15b0dd)
```

如果要推送某個標籤到遠程，使用命令git push origin &lt;tagname>：

```shell
$ git push origin v1.0
Total 0 (delta 0), reused 0 (delta 0)
To github.com:michaelliao/learngit.git
 * [new tag]         v1.0 -> v1.0
```
或者，一次性推送全部尚未推送到遠程的本地標籤：
``` shell
$ git push origin --tags
Total 0 (delta 0), reused 0 (delta 0)
To github.com:michaelliao/learngit.git
 * [new tag]         v0.9 -> v0.9
```
如果標籤已經推送到遠程，要刪除遠程標籤就麻煩一點，先從本地刪除：
``` shell
$ git tag -d v0.9
Deleted tag 'v0.9' (was f52c633)
```
然後，從遠程刪除。刪除命令也是push，但是格式如下：
``` shell
$ git push origin :refs/tags/v0.9
To github.com:michaelliao/learngit.git
 - [deleted]         v0.9
```
