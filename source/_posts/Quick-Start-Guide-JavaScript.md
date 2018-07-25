---
title: Quick Start Guide JavaScript
date: 2018-07-18 06:09:18
tags:
- Quick Start Guide
- JavaScript
---
## 关于js、浏览器、node.js之间关系梳理

| JavaScript | java   |
|:-----------|:-------|
| V8         | JVM    |
| node.js    | JRE    |
| browser    | Applet |

- JavaScript：脚本语言
- v8：(浏览器内核、node.js内核)相当于java中的JVM(虚拟机字-节码解释器)
- node.js：文件系统I/O、网络（HTTP、TCP、UDP、DNS、TLS/SSL等）、二进制数据流、加密算法、数据流等等
- 浏览器：文档对象模型（DOM）浏览器对象模型（BOM）出于安全考虑，浏览器中的js只能操作DOM BOM对象，功能受限。

## 基本语法

### 程序注释
以`//`开头直到行末的字符被视为行注释，注释是给开发人员看到，JavaScript引擎会自动忽略：
```javascript
// 这是一行注释
alert('hello'); // 这也是注释
```
另一种块注释是用`/*...*/`把多行字符包裹起来，把一大"块"视为一个注释：
```javascript
/* 从这里开始是块注释
仍然是注释
仍然是注释
注释结束 */
```
### 变量
变量的概念基本上和初中代数的方程变量是一致的，只是在计算机程序中，变量不仅可以是数字，还可以是任意数据类型。

变量在JavaScript中就是用一个变量名表示，变量名是大小写英文、数字、`$`和`_`的组合，且不能用数字开头。变量名也不能是JavaScript的关键字，如`if`、`while`等。申明一个变量用`var`语句，比如：
```javascript
var a; // 申明了变量a，此时a的值为undefined
var $b = 1; // 申明了变量$b，同时给$b赋值，此时$b的值为1
var s_007 = '007'; // s_007是一个字符串
var Answer = true; // Answer是一个布尔值true
var t = null; // t的值是null
```

### 变量的类型
- Number
JavaScript 只有一种数字类型。数字可以带小数点，也可以不带：
```javascript
var x1=123; // 整数123
var x2=0.456; // 浮点数0.456
var x3=1.2345e3; // 科学计数法表示1.2345x1000，等同于1234.5
var x4=-99; // 负数
var x5=NaN; // NaN表示Not a Number，当无法计算结果时用NaN表示
var x6=Infinity; // Infinity表示无限大，当数值超过了JavaScript的Number所能表示的最大值时，就表示为Infinity
```
- 字符串
字符串是以单引号'或双引号"括起来的任意文本，比如`'abc'`，`"xyz"`等等。请注意，`''`或`""`本身只是一种表示方式，不是字符串的一部分，因此，字符串`'abc'`只有`a`，`b`，`c`这3个字符。
``` javascript
var answer="Nice to meet you!";
var answer="He is called 'Bill'";
var answer='He is called "Bill"';
```

- 布尔值
布尔（逻辑）只能有两个值：true 或 false。
```javascript
var x=true
var y=false
```
- 数组
数组是一组按顺序排列的集合，集合的每个值称为元素。JavaScript的数组可以包括任意数据类型。例如：
```javascript
[1, 2, 3.14, 'Hello', null, true];
```
- Map
- Set
- 对象
JavaScript的对象是一组由键-值组成的无序集合，例如：
``` javascript
var person = {
    name: 'Bob',
    age: 20,
    tags: ['js', 'web', 'mobile'],
    city: 'Beijing',
    hasCar: true,
    zipcode: null
};
```
JavaScript对象的键都是字符串类型，值可以是任意数据类型。上述`person`对象一共定义了6个键值对，其中每个键又称为对象的属性，例如，`person`的`name`属性为`'Bob'`，`zipcode`属性为`null`。
要获取一个对象的属性，我们用`对象变量.属性名`的方式：

``` javascript
person.name; // 'Bob'
person.zipcode; // null
```

- strict模式

### 常量
### 运算符
### 表达式

## 流程控制结构
### 分支结构
### 循环结构
### 特殊的流程控制语句

## 函数
### 函数的定义
```javascript
function abs(x) {
    if (typeof x !== 'number') {
        throw 'Not a number';
    }
    if (x >= 0) {
        return x;
    } else {
        return -x;
    }
}
```

JavaScript的函数也是一个对象，上述定义的`abs()`函数实际上是一个函数对象，而函数名`abs`可以视为指向该函数的变量。
```javascript
var abs = function (x) {
     if (typeof x !== 'number') {
            throw 'Not a number';
     }
    if (x >= 0) {
        return x;
    } else {
        return -x;
    }
};
```
### 调用函数
```javascript
abs(10); // 返回10
abs(-9); // 返回9
```

## 面向对象的程序设计

## 错误和异常处理

## IO编程

## 进程和线程

## 正则表达式

## 常用内建模块

### 日期和时间
### 动态图像处理
### XML

## 三方功能模块

## 图形界面

## 网络编程

## 访问数据库

## 模板引擎

## mvc/web开发

## 异步IO

## 框架