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
### 变量
```javascript
var x = 1; 
var y = 2; // 不建议一行写多个语句!
```
### 变量的类型
- Number
```javascript
123; // 整数123
0.456; // 浮点数0.456
1.2345e3; // 科学计数法表示1.2345x1000，等同于1234.5
-99; // 负数
NaN; // NaN表示Not a Number，当无法计算结果时用NaN表示
Infinity; // Infinity表示无限大，当数值超过了JavaScript的Number所能表示的最大值时，就表示为Infinity
```
- 字符串
- 布尔值
- 比较运算符
- 数组
- Map
- Set
- 对象
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