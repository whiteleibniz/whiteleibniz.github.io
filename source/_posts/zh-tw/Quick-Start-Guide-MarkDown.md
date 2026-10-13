---
title: Quick Start Guide MarkDown
date: 2018-07-12 14:53:24
lang: zh-TW
tags:
- Quick Start Guide
- MarkDown
permalink: zh-tw/2018/07/12/Quick-Start-Guide-MarkDown/
---

# markdown 語法快速學習

# 一.字號
~~~markdown
# 這是字號1
## 這是字號2
### 這是字號3
#### 這是字號4
##### 這是字號5
###### 這是字號6
~~~
# 這是字號1
## 這是字號2
### 這是字號3
#### 這是字號4
##### 這是字號5
###### 這是字號6



# 二.引用塊

~~~markdown
> 您的好友已上線
>> 黑百合報道
>> 半藏報道
>>> **這遊戲還能不能玩了？**　　　（此處有三個空格哦～否則不換行）
>>> **感覺隊伍少了兩個人**
~~~

> 您的好友已上線
>> 黑百合報道
>> 半藏報道
>>> **這遊戲還能不能玩了？**
>>> **感覺隊伍少了兩個人**

# 三.強調


~~~markdown
**strong** *line*
__strong__ _line_
~~~
**strong** *line*

__strong__ _line_

# 四.圖片
~~~markdown
![本地](github.jpg)
![網絡](https://www.baidu.com/img/bd_logo1.png)
~~~
![本地](github.jpg)
![網絡](https://www.baidu.com/img/bd_logo1.png)


# 五.超鏈接
~~~ markdown
[Baidu](http://www.baidu.com)
~~~
[Baidu](http://www.baidu.com)

# 六.顯示代碼
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
# 八.分割線
~~~ markdown
---
~~~
---

# 九.分點
~~~ markdown
1. One
2. Two
3. Three
~~~
1. One
2. Two
3. Three

# 十.html擴展
~~~ markdown
支持html標籤擴展結構
<h5 style="color:red">這是html擴展標籤</h5>
~~~
<h5 style="color:red">這是html擴展標籤</h5>
