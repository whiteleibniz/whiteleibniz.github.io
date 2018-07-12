---
title: Quick Start Guide MarkDown
date: 2018-07-12 14:53:24
tags:
- Quick Start Guide
- MarkDown
---

# markdown 语法快速学习

# 一.字号
~~~markdown
# 这是字号1
## 这是字号2
### 这是字号3
#### 这是字号4
##### 这是字号5
###### 这是字号6
~~~
# 这是字号1
## 这是字号2
### 这是字号3
#### 这是字号4
##### 这是字号5
###### 这是字号6



# 二.引用块

~~~markdown
> 您的好友已上线
>> 黑百合报道
>> 半藏报道
>>> **这游戏还能不能玩了？**　　　（此处有三个空格哦～否则不换行）
>>> **感觉队伍少了两个人**
~~~

> 您的好友已上线
>> 黑百合报道
>> 半藏报道
>>> **这游戏还能不能玩了？**
>>> **感觉队伍少了两个人**

# 三.强调


~~~markdown
**strong** *line*
__strong__ _line_
~~~
**strong** *line*

__strong__ _line_

# 四.图片
~~~markdown
![本地](github.jpg)
![网络](https://www.baidu.com/img/bd_logo1.png)
~~~
![本地](github.jpg)
![网络](https://www.baidu.com/img/bd_logo1.png)


# 五.超链接
~~~ markdown
[Baidu](http://www.baidu.com)
~~~
[Baidu](http://www.baidu.com)

# 六.显示代码
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
# 七.表格
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
# 八.分割线
~~~ markdown
---
~~~
---

# 九.分点
~~~ markdown
1. One
2. Two
3. Three
~~~
1. One
2. Two
3. Three

# 十.html扩展
~~~ markdown
支持html标签扩展结构
<h5 style="color:red">这是html扩展标签</h5>
~~~
<h5 style="color:red">这是html扩展标签</h5>
