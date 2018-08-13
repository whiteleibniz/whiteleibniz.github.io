---
title: Quick Start Guide JavaScript
date: 2018-07-18 06:09:18
tags:
- Quick Start Guide
- JavaScript
---

## 关于js、浏览器、node.js之间关系梳理

| JavaScript | java   |
| :--------- | :----- |
| V8         | JVM    |
| node.js    | JRE    |
| browser    | Applet |

-   JavaScript：脚本语言
-   v8：(浏览器内核、node.js内核)相当于java中的JVM(虚拟机字-节码解释器)
-   node.js：文件系统I/O、网络（HTTP、TCP、UDP、DNS、TLS/SSL等）、二进制数据流、加密算法、数据流等等
-   浏览器：文档对象模型（DOM）浏览器对象模型（BOM）出于安全考虑，浏览器中的js只能操作DOM BOM对象，功能受限。

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

-   Number
      JavaScript 只有一种数字类型。数字可以带小数点，也可以不带：
    ```javascript
    var x1=123; // 整数123
    var x2=0.456; // 浮点数0.456
    var x3=1.2345e3; // 科学计数法表示1.2345x1000，等同于1234.5
    var x4=-99; // 负数
    var x5=NaN; // NaN表示Not a Number，当无法计算结果时用NaN表示
    var x6=Infinity; // Infinity表示无限大，当数值超过了JavaScript的Number所能表示的最大值时，就表示为Infinity
    ```
-   字符串
    字符串是以单引号'或双引号"括起来的任意文本，比如`'abc'`，`"xyz"`等等。请注意，`''`或`""`本身只是一种表示方式，不是字符串的一部分，因此，字符串`'abc'`只有`a`，`b`，`c`这3个字符。

    ```javascript
    var answer="Nice to meet you!";
    var answer="He is called 'Bill'";
    var answer='He is called "Bill"';
    ```

-   布尔值
    布尔（逻辑）只能有两个值：true 或 false。

    ```javascript
    var x=true
    var y=false
    ```

-   数组
    数组是一组按顺序排列的集合，集合的每个值称为元素。JavaScript的数组可以包括任意数据类型。例如：
    ```javascript
    [1, 2, 3.14, 'Hello', null, true];
    ```
-   Map
    Map是一组键值对的结构，具有极快的查找速度。

    ```javascript
    var m = new Map([['Michael', 95], ['Bob', 75], ['Tracy', 85]]);
    m.get('Michael'); // 95
    ```

    初始化Map需要一个二维数组，或者直接初始化一个空Map。Map具有以下方法：

    ```javascript
    var m = new Map(); // 空Map
    m.set('Adam', 67); // 添加新的key-value
    m.set('Bob', 59);
    m.has('Adam'); // 是否存在key 'Adam': true
    m.get('Adam'); // 67
    m.delete('Adam'); // 删除key 'Adam'
    m.get('Adam'); // undefined
    ```

    由于一个key只能对应一个value，所以，多次对一个key放入value，后面的值会把前面的值冲掉：

    ```javascript
    var m = new Map();
    m.set('Adam', 67);
    m.set('Adam', 88);
    m.get('Adam'); // 88
    ```

-   Set

    Set和Map类似，也是一组key的集合，但不存储value。由于key不能重复，所以，在Set中，没有重复的key。
    要创建一个Set，需要提供一个Array作为输入，或者直接创建一个空Set：

    ```JavaScript
    var s1 = new Set(); // 空Set
    var s2 = new Set([1, 2, 3]); // 含1, 2, 3
    ```

    重复元素在Set中自动被过滤：

    ```javascript
    var s = new Set([1, 2, 3, 3, '3']);
    s; // Set {1, 2, 3, "3"}
    ```

    注意数字3和字符串'3'是不同的元素。
    通过add(key)方法可以添加元素到Set中，可以重复添加，但不会有效果：

    ```javascript
    s.add(4);
    s; // Set {1, 2, 3, 4}
    s.add(4);
    s; // 仍然是 Set {1, 2, 3, 4}
    ```

    通过delete(key)方法可以删除元素：

    ```javascript
    var s = new Set([1, 2, 3]);
    s; // Set {1, 2, 3}
    s.delete(3);
    s; // Set {1, 2}
    ```

-   对象

    JavaScript的对象是一组由键-值组成的无序集合，例如：

    ```javascript
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

    ```javascript
    person.name; // 'Bob'
    person.zipcode; // null
    ```

-   Undefined 和 Null

    null表示一个“空”的值，它和0以及空字符串''不同，0是一个数值，''表示长度为0的字符串，而null表示“空”。

    在其他语言中，也有类似JavaScript的null的表示，例如Java也用null，Swift用nil，Python用None表示。但是，在JavaScript中，还有一个和null类似的undefined，它表示“未定义”。

    JavaScript的设计者希望用null表示一个空的值，而undefined表示值未定义。事实证明，这并没有什么卵用，区分两者的意义不大。大多数情况下，我们都应该用null。undefined仅仅在判断函数参数是否传递的情况下有用。

-   strict模式

    JavaScript在设计之初，为了方便初学者学习，并不强制要求用var申明变量。这个设计错误带来了严重的后果：如果一个变量没有通过var申明就被使用，那么该变量就自动被申明为全局变量：

    ```javascript
    i = 10; // i现在是全局变量
    ```

    在同一个页面的不同的JavaScript文件中，如果都不用var申明，恰好都使用了变量i，将造成变量i互相影响，产生难以调试的错误结果。

    使用var申明的变量则不是全局变量，它的范围被限制在该变量被申明的函数体内（函数的概念将稍后讲解），同名变量在不同的函数体内互不冲突。

    为了修补JavaScript这一严重设计缺陷，ECMA在后续规范中推出了strict模式，在strict模式下运行的JavaScript代码，强制通过var申明变量，未使用var申明变量就使用的，将导致运行错误。

    启用strict模式的方法是在JavaScript代码的第一行写上:

    ```javascript
    'use strict';
    ```

    这是一个字符串，不支持strict模式的浏览器会把它当做一个字符串语句执行，支持strict模式的浏览器将开启strict模式运行JavaScript。

### 常量

### 运算符

-   运算符 +

    javascript中+运算符有2个作用一是数学意义上的加减，另一种则用于字符串的拼接

    ```javascript
    //数学运算
    y=5;
    z=2;
    x=y+z;
    //字符串的拼接
    txt1="What a very";
    txt2="nice day";
    txt3=txt1+" "+txt2;
    ```

-   JavaScript 算术运算符

    算术运算符用于执行变量与/或值之间的算术运算。
    给定 y=5，下面的表格解释了这些算术运算符：

| 运算符 | 描述         | 例子     | 结果    |
| --- | ---------- | ------ | ----- |
| +   | 加          | x=y+2  | x=7   |
| -   | 减          | x=y-2  | x=3   |
| \*  | 乘          | x=y\*2 | x=10  |
| /   | 除          | x=y/2  | x=2.5 |
| %   | 求余数 (保留整数) | x=y%2  | x=y%2 |
| ++  | 累加         | x=++y  | x=6   |
| --  | 递减         | x=--y  | x=4   |

-   JavaScript 赋值运算符

    赋值运算符用于给 JavaScript 变量赋值。
    给定 x=10 和 y=5，下面的表格解释了赋值运算符：

| 运算符 | 例子    | 等价于    | 结果   |
| --- | ----- | ------ | ---- |
| =   | x=y   |        | x=5  |
| +=  | x+=y  | x=x+y  | x=15 |
| -=  | x-=y  | x=x-y  | x=5  |
| \*= | x\*=y | x=x\*y | x=50 |
| /=  | x/=y  | x=x/y  | x=2  |
| %=  | x%=y  | x=x%y  | x=0  |

-   JavaScript 比较运算符

    比较运算符在逻辑语句中使用，以测定变量或值是否相等。
    给定 x=5，下面的表格解释了比较运算符：

| 运算符   |     | 描述       | 例子                           |
| ----- | --- | -------- | ---------------------------- |
| ==    |     | 等于       | x==8 为 false                 |
| ===   |     | 全等（值和类型） | x===5 为 true；x==="5" 为 false |
| !=    |     | 不等于      | x!=8 为 true                  |
| >     |     | 大于       | x>8 为 false                  |
| &lt;  |     | 小于       | x&lt;8 为 true                |
| >=    |     | 大于或等于    | x>=8 为 false                 |
| &lt;= |     | 小于或等于    | x&lt;=8 为 true               |

-   JavaScript 逻辑运算符

    逻辑运算符用于测定变量或值之间的逻辑。
    给定 x=6 以及 y=3，下表解释了逻辑运算符：

| 运算符  | 描述  | 例子                          |
| ---- | --- | --------------------------- |
| &&   | and | (x &lt; 10 && y > 1) 为 true |
| \|\| | or  | (x==5\|\|y==5) 为 false      |
| !    | not | !(x==y) 为 true              |

-   javascript 条件运算符

    JavaScript 还包含了基于某些条件对变量进行赋值的条件运算符。

    ```javascript
    variablename=(condition)?value1:value2
    ```

### 表达式

## 流程控制结构

### 分支结构

-   if 语句 - 只有当指定条件为 true 时，使用该语句来执行代码

    ```javascript
    if (time<20)
    {
    x="Good day";
    }
    ```

-   if...else 语句 - 当条件为 true 时执行代码，当条件为 false 时执行其他代码

    ```javascript
    if (time<20)
      {
      x="Good day";
      }
    else
      {
      x="Good evening";
      }
    ```

-   if...else if....else 语句 - 使用该语句来选择多个代码块之一来执行

    ```javascript
    if (time<10)
      {
      x="Good morning";
      }
    else if (time<20)
      {
      x="Good day";
      }
    else
      {
      x="Good evening";
      }
    ```

-   switch 语句 - 使用该语句来选择多个代码块之一来执行

    ```javascript
    var day=new Date().getDay();
    switch (day)
    {
    case 0:
      x="Today it's Sunday";
      break;
    case 1:
      x="Today it's Monday";
      break;
    case 2:
      x="Today it's Tuesday";
      break;
    case 3:
      x="Today it's Wednesday";
      break;
    case 4:
      x="Today it's Thursday";
      break;
    case 5:
      x="Today it's Friday";
      break;
    case 6:
      x="Today it's Saturday";
      break;
    }
    ```

-   default 关键词 - 使用 default 关键词来规定匹配不存在时做的事情

    ```javascript
    var day=new Date().getDay();
    switch (day)
    {
    case 6:
      x="Today it's Saturday";
      break;
    case 0:
      x="Today it's Sunday";
      break;
    default:
      x="Looking forward to the Weekend";
    }
    ```

### 循环结构

-   for - 循环代码块一定的次数

    ```javascript
    for (var i=0; i<5; i++)
      {
      x=x + "The number is " + i + "<br>";
      }
    ```

-   for/in - 循环遍历对象的属性

    ```javascript
    var person={fname:"John",lname:"Doe",age:25};
    for (x in person)
      {
      txt=txt + person[x];
      }
    ```

-   for/of 具有iterable类型的集合可以通过新的for/of循环来遍历。

    ```javascript
    var a = ['A', 'B', 'C'];
    var s = new Set(['A', 'B', 'C']);
    var m = new Map([[1, 'x'], [2, 'y'], [3, 'z']]);
    for (var x of a) { // 遍历Array
        console.log(x);
    }
    for (var x of s) { // 遍历Set
        console.log(x);
    }
    for (var x of m) { // 遍历Map
        console.log(x[0] + '=' + x[1]);
    }
    ```

-   forEach() 它接收一个函数，每次迭代就自动回调该函数

    ```javascript
    'use strict';
    var a = ['A', 'B', 'C'];
    a.forEach(function (element, index, array) {
    // element: 指向当前元素的值
    // index: 指向当前索引
    // array: 指向Array对象本身
    console.log(element + ', index = ' + index);
    });
    ```

-   while - 当指定的条件为 true 时循环指定的代码块

    ```javascript
    while (i<5)
    {
    x=x + "The number is " + i + "<br>";
    i++;
    }
    ```

-   do/while - 同样当指定的条件为 true 时循环指定的代码块

    ```javascript
    do
      {
      x=x + "The number is " + i + "<br>";
      i++;
      }
    while (i<5);
    ```

### 特殊的流程控制语句

-   Break 语句

    我们已经switch中见到过 break 语句。它用于跳出 switch() 语句。
    break 语句可用于跳出循环。
    break 语句跳出循环后，会继续执行该循环之后的代码（如果有的话）：

    ```javascript
    for (i=0;i<10;i++)
    {
    if (i==3)
    {
    break;
    }
    x=x + "The number is " + i + "<br>";
    }
    ```

-   Continue 语句

    continue 语句中断循环中的迭代，如果出现了指定的条件，然后继续循环中的下一个迭代。
    该例子跳过了值 3：

    ```javascript
    for (i=0;i<=10;i++)
    {
    if (i==3) continue;
    x=x + "The number is " + i + "<br>";
    }
    ```

## 函数

借助抽象，我们才能不关心底层的具体计算过程，而直接在更高的层次上思考问题。
写计算机程序也是一样，函数就是最基本的一种代码抽象的方式。

### 函数的定义与调用

-   定义

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

-   调用

    ```javascript
    abs(10); // 返回10
    abs(-9); // 返回9
    ```

-   arguments

    JavaScript还有一个免费赠送的关键字arguments，它只在函数内部起作用，并且永远指向当前函数的调用者传入的所有参数。arguments类似Array但它不是一个Array：
    利用arguments，你可以获得调用者传入的所有参数。也就是说，即使函数不定义任何参数，还是可以拿到参数的值：

    ```javascript
    function abs() {
    if (arguments.length === 0) {
        return 0;
    }
    var x = arguments[0];
    return x >= 0 ? x : -x;
    }

    abs(); // 0
    abs(10); // 10
    abs(-9); // 9
    ```

-   rest参数
    由于JavaScript函数允许接收任意个参数，于是我们就不得不用arguments来获取所有参数：

    ```javascript
    function foo(a, b) {
    var i, rest = [];
    if (arguments.length > 2) {
        for (i = 2; i<arguments.length; i++) {
            rest.push(arguments[i]);
        }
    }
    console.log('a = ' + a);
    console.log('b = ' + b);
    console.log(rest);
    }
    ```

    为了获取除了已定义参数a、b之外的参数，我们不得不用arguments，并且循环要从索引2开始以便排除前两个参数，这种写法很别扭，只是为了获得额外的rest参数，有没有更好的方法？

    ES6标准引入了rest参数，上面的函数可以改写为：

    ```javascript
    function foo(a, b, ...rest) {
    console.log('a = ' + a);
    console.log('b = ' + b);
    console.log(rest);
    }

    foo(1, 2, 3, 4, 5);
    // 结果:
    // a = 1
    // b = 2
    // Array [ 3, 4, 5 ]

    foo(1);
    // 结果:
    // a = 1
    // b = undefined
    // Array []
    ```

    rest参数只能写在最后，前面用...标识，从运行结果可知，传入的参数先绑定a、b，多余的参数以数组形式交给变量rest，所以，不再需要arguments我们就获取了全部参数。

    如果传入的参数连正常定义的参数都没填满，也不要紧，rest参数会接收一个空数组（注意不是undefined）。

### 变量作用域与解构赋值

在JavaScript中，用var申明的变量实际上是有作用域的。
如果一个变量在函数体内部申明，则该变量的作用域为整个函数体，在函数体外不可引用该变量：

-   局部 JavaScript 变量

    ```javascript
    'use strict';

    function foo() {
        var x = 1;
        x = x + 1;
    }

    x = x + 2; // ReferenceError! 无法在函数体外引用变量x
    ```

-   变量提升

    JavaScript的函数定义有个特点，它会先扫描整个函数体的语句，把所有申明的变量“提升”到函数顶部：

    ```javascript
    'use strict';

    function foo() {
        var x = 'Hello, ' + y;
        console.log(x);
        var y = 'Bob';
    }

    foo();
    ```

    虽然是strict模式，但语句var x = 'Hello, ' + y;并不报错，原因是变量y在稍后申明了。但是console.log显示Hello, undefined，说明变量y的值为undefined。这正是因为JavaScript引擎自动提升了变量y的声明，但不会提升变量y的赋值。

    对于上述foo()函数，JavaScript引擎看到的代码相当于：

    ```javascript
    function foo() {
    var y; // 提升变量y的申明，此时y为undefined
    var x = 'Hello, ' + y;
    console.log(x);
    y = 'Bob';
    }
    ```

    由于JavaScript的这一怪异的“特性”，我们在函数内部定义变量时，请严格遵守“**在函数内部首先申明所有变量**”这一规则。最常见的做法是用一个var申明函数内部用到的所有变量：

    ```javascript
    function foo() {
    var
        x = 1, // x初始化为1
        y = x + 1, // y初始化为2
        z, i; // z和i为undefined
    // 其他语句:
    for (i=0; i<100; i++) {
        ...
    }
    }
    ```


-   全局 JavaScript 变量
    不在任何函数内定义的变量就具有全局作用域。实际上，JavaScript默认有一个全局对象window，全局作用域的变量实际上被绑定到window的一个属性：

    ```javascript
    'use strict';

    var course = 'Learn JavaScript';
    alert(course); // 'Learn JavaScript'
    alert(window.course); // 'Learn JavaScript'
    ```

    因此，直接访问全局变量course和访问window.course是完全一样的。

    你可能猜到了，由于函数定义有两种方式，以变量方式var foo = function () {}定义的函数实际上也是一个全局变量，因此，顶层函数的定义也被视为一个全局变量，并绑定到window对象：

    ```javascript
    'use strict';

    function foo() {
        alert('foo');
    }

    foo(); // 直接调用foo()
    window.foo(); // 通过window.foo()调用
    ```

    进一步大胆地猜测，我们每次直接调用的alert()函数其实也是window的一个变量：

    ```javascript
    'use strict';
    window.alert('调用window.alert()');
    // 把alert保存到另一个变量:
    var old_alert = window.alert;
    // 给alert赋一个新函数:
    window.alert = function () {}
    alert('无法用alert()显示了!');
    // 恢复alert:
    window.alert = old_alert;
    alert('又可以用alert()了!');
    ```

    这说明JavaScript实际上只有一个全局作用域。任何变量（函数也视为变量），如果没有在当前函数作用域中找到，就会继续往上查找，最后如果在全局作用域中也没有找到，则报ReferenceError错误。

-   名字空间
    全局变量会绑定到window上，不同的JavaScript文件如果使用了相同的全局变量，或者定义了相同名字的顶层函数，都会造成命名冲突，并且很难被发现。

    减少冲突的一个方法是把自己的所有变量和函数全部绑定到一个全局变量中。例如：

    ```javascript
    // 唯一的全局变量MYAPP:
    var MYAPP = {};

    // 其他变量:
    MYAPP.name = 'myapp';
    MYAPP.version = 1.0;

    // 其他函数:
    MYAPP.foo = function () {
        return 'foo';
    };
    ```
    把自己的代码全部放入唯一的名字空间MYAPP中，会大大减少全局变量冲突的可能。

    许多著名的JavaScript库都是这么干的：jQuery，YUI，underscore等等。

-   JavaScript 变量的生存期
-   向未声明的 JavaScript 变量来分配值

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
