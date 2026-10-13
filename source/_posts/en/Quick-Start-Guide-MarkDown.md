---
title: Quick Start Guide MarkDown
date: 2018-07-12 14:53:24
lang: en
permalink: en/2018/07/12/Quick-Start-Guide-MarkDown/
tags:
- Quick Start Guide
- MarkDown
---

# Quick Learning of Markdown Syntax

# 1. Font Size
~~~markdown
# 这是字号1
## 这是字号2
### 这是字号3
#### 这是字号4
##### 这是字号5
###### 这是字号6
~~~
# This is font size 1
## This is font size 2
### This is font size 3
#### This is font size 4
##### This is font size 5
###### This is font size 6



# 2. Blockquote

~~~markdown
> 您的好友已上线
>> 黑百合报道
>> 半藏报道
>>> **这游戏还能不能玩了？**　　　（此处有三个空格哦～否则不换行）
>>> **感觉队伍少了两个人**
~~~

> Your friend is online
>> Widowmaker reporting
>> Hanzo reporting
>>> **Can this game still be played?**
>>> **It feels like the team is two players short**

# 3. Emphasis


~~~markdown
**strong** *line*
__strong__ _line_
~~~
**strong** *line*

__strong__ _line_

# 4. Images
~~~markdown
![本地](github.jpg)
![网络](https://www.baidu.com/img/bd_logo1.png)
~~~
![Local](github.jpg)
![Online](https://www.baidu.com/img/bd_logo1.png)


# 5. Hyperlinks
~~~ markdown
[Baidu](http://www.baidu.com)
~~~
[Baidu](http://www.baidu.com)

# 6. Displaying Code
~~~markdown
~~~java
  public void hello();
~~~ or
```java
public void hello();
```
~~~
~~~java
public void hello();
~~~
```java
public void hello();
```
# 7. Tables
~~~ markdown
| name     | sex    | age |
| -------- | ------ | --- |
| jake     | male   | 18  |
| xiaoming | female | 20  |
| lucy     | male   | 22  |
~~~
| name     | sex    | age |
| -------- | ------ | --- |
| jake     | male   | 18  |
| xiaoming | female | 20  |
| lucy     | male   | 22  |
# 8. Horizontal Rule
~~~ markdown
---
~~~
---

# 9. Lists
~~~ markdown
1. One
2. Two
3. Three
~~~
1. One
2. Two
3. Three

# 10. HTML Extensions
~~~ markdown
支持html标签扩展结构
<h5 style="color:red">这是html扩展标签</h5>
~~~
<h5 style="color:red">This is an HTML extension tag</h5>
