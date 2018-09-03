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

由于var和let申明的是变量，如果要申明一个常量，在ES6之前是不行的，我们通常用全部大写的变量来表示“这是一个常量，不要修改它的值”：

```javascript
var PI = 3.14;
```

ES6标准引入了新的关键字const来定义常量，const与let都具有块级作用域：

```javascript
'use strict';

const PI = 3.14;
PI = 3; // 某些浏览器不报错，但是无效果！
PI; // 3.14
```

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

-   局部作用域

    由于JavaScript的变量作用域实际上是函数内部，我们在for循环等语句块中是无法定义具有局部作用域的变量的：

    ```javascript
    'use strict';

    function foo() {
        for (var i=0; i<100; i++) {
            //
        }
        i += 100; // 仍然可以引用变量i
    }
    ```

    为了解决块级作用域，ES6引入了新的关键字let，用let替代var可以申明一个块级作用域的变量：

    ```javascript
    'use strict';

    function foo() {
        var sum = 0;
        for (let i=0; i<100; i++) {
            sum += i;
        }
        // SyntaxError:
        i += 1;
    }
    ```

-   解构赋值

    从ES6开始，JavaScript引入了解构赋值，可以同时对一组变量进行赋值。

    什么是解构赋值？我们先看看传统的做法，如何把一个数组的元素分别赋值给几个变量：

    ```javascript
    var array = ['hello', 'JavaScript', 'ES6'];
    var x = array[0];
    var y = array[1];
    var z = array[2];
    ```

    现在，在ES6中，可以使用解构赋值，直接对多个变量同时赋值：

    ```javascript
    'use strict';

    // 如果浏览器支持解构赋值就不会报错:
    var [x, y, z] = ['hello', 'JavaScript', 'ES6'];
    ```

    注意，对数组元素进行解构赋值时，多个变量要用[...]括起来。

    如果数组本身还有嵌套，也可以通过下面的形式进行解构赋值，注意嵌套层次和位置要保持一致：

    ```javascript
    let [x, [y, z]] = ['hello', ['JavaScript', 'ES6']];
    x; // 'hello'
    y; // 'JavaScript'
    z; // 'ES6'
    ```

    解构赋值还可以忽略某些元素：

    ```javascript
    let [, , z] = ['hello', 'JavaScript', 'ES6']; // 忽略前两个元素，只对z赋值第三个元素
    z; // 'ES6'
    ```

    如果需要从一个对象中取出若干属性，也可以使用解构赋值，便于快速获取对象的指定属性：

    ```javascript
    'use strict';

    var person = {
        name: '小明',
        age: 20,
        gender: 'male',
        passport: 'G-12345678',
        school: 'No.4 middle school'
    };
    var {name, age, passport} = person;
    ```

    对一个对象进行解构赋值时，同样可以直接对嵌套的对象属性进行赋值，只要保证对应的层次是一致的：

    ```javascript
    var person = {
    name: '小明',
    age: 20,
    gender: 'male',
    passport: 'G-12345678',
    school: 'No.4 middle school',
    address: {
        city: 'Beijing',
        street: 'No.1 Road',
        zipcode: '100001'
    }
    };
    var {name, address: {city, zip}} = person;
    name; // '小明'
    city; // 'Beijing'
    zip; // undefined, 因为属性名是zipcode而不是zip
    // 注意: address不是变量，而是为了让city和zip获得嵌套的address对象的属性:
    address; // Uncaught ReferenceError: address is not defined
    ```

    使用解构赋值对对象属性进行赋值时，如果对应的属性不存在，变量将被赋值为undefined，这和引用一个不存在的属性获得undefined是一致的。如果要使用的变量名和属性名不一致，可以用下面的语法获取：

    ```javascript
    var person = {
    name: '小明',
    age: 20,
    gender: 'male',
    passport: 'G-12345678',
    school: 'No.4 middle school'
    };

    // 把passport属性赋值给变量id:
    let {name, passport:id} = person;
    name; // '小明'
    id; // 'G-12345678'
    // 注意: passport不是变量，而是为了让变量id获得passport属性:
    passport; // Uncaught ReferenceError: passport is not defined
    ```

    解构赋值还可以使用默认值，这样就避免了不存在的属性返回undefined的问题：

    ```javascript
    var person = {
    name: '小明',
    age: 20,
    gender: 'male',
    passport: 'G-12345678'
    };

    // 如果person对象没有single属性，默认赋值为true:
    var {name, single=true} = person;
    name; // '小明'
    single; // true
    ```

    有些时候，如果变量已经被声明了，再次赋值的时候，正确的写法也会报语法错误：

    ```javascript
    // 声明变量:
    var x, y;
    // 解构赋值:
    {x, y} = { name: '小明', x: 100, y: 200};
    // 语法错误: Uncaught SyntaxError: Unexpected token =
    ```

    这是因为JavaScript引擎把{开头的语句当作了块处理，于是=不再合法。解决方法是用小括号括起来：

    ```javascript
    ({x, y} = { name: '小明', x: 100, y: 200});
    ```

### 方法

在一个对象中绑定函数，称为这个对象的方法。

在JavaScript中，对象的定义是这样的：

```javascript
var xiaoming = {
    name: '小明',
    birth: 1990
};
```

但是，如果我们给xiaoming绑定一个函数，就可以做更多的事情。比如，写个age()方法，返回xiaoming的年龄：

```javascript
var xiaoming = {
    name: '小明',
    birth: 1990,
    age: function () {
        var y = new Date().getFullYear();
        return y - this.birth;
    }
};

xiaoming.age; // function xiaoming.age()
xiaoming.age(); // 今年调用是25,明年调用就变成26了
```

绑定到对象上的函数称为方法，和普通函数也没啥区别，但是它在内部使用了一个this关键字，这个东东是什么？

在一个方法内部，this是一个特殊变量，它始终指向当前对象，也就是xiaoming这个变量。所以，this.birth可以拿到xiaoming的birth属性。

让我们拆开写：

```javascript
function getAge() {
    var y = new Date().getFullYear();
    return y - this.birth;
}

var xiaoming = {
    name: '小明',
    birth: 1990,
    age: getAge
};

xiaoming.age(); // 25, 正常结果
getAge(); // NaN
```

单独调用函数getAge()怎么返回了NaN？请注意，我们已经进入到了JavaScript的一个大坑里。

JavaScript的函数内部如果调用了this，那么这个this到底指向谁？

答案是，视情况而定！

如果以对象的方法形式调用，比如xiaoming.age()，该函数的this指向被调用的对象，也就是xiaoming，这是符合我们预期的。

如果单独调用函数，比如getAge()，此时，该函数的this指向全局对象，也就是window。

坑爹啊！

更坑爹的是，如果这么写：

```javascript
var fn = xiaoming.age; // 先拿到xiaoming的age函数
fn(); // NaN
```

也是不行的！要保证this指向正确，必须用obj.xxx()的形式调用！

由于这是一个巨大的设计错误，要想纠正可没那么简单。ECMA决定，在strict模式下让函数的this指向undefined，因此，在strict模式下，你会得到一个错误：

```javascript
'use strict';

var xiaoming = {
    name: '小明',
    birth: 1990,
    age: function () {
        var y = new Date().getFullYear();
        return y - this.birth;
    }
};

var fn = xiaoming.age;
fn(); // Uncaught TypeError: Cannot read property 'birth' of undefined
```

这个决定只是让错误及时暴露出来，并没有解决this应该指向的正确位置。

有些时候，喜欢重构的你把方法重构了一下：

```javascript
'use strict';

var xiaoming = {
    name: '小明',
    birth: 1990,
    age: function () {
        function getAgeFromBirth() {
            var y = new Date().getFullYear();
            return y - this.birth;
        }
        return getAgeFromBirth();
    }
};

xiaoming.age(); // Uncaught TypeError: Cannot read property 'birth' of undefined
```

结果又报错了！原因是this指针只在age方法的函数内指向xiaoming，在函数内部定义的函数，this又指向undefined了！（在非strict模式下，它重新指向全局对象window！）

修复的办法也不是没有，我们用一个that变量首先捕获this：

```javascript
'use strict';

var xiaoming = {
    name: '小明',
    birth: 1990,
    age: function () {
        var that = this; // 在方法内部一开始就捕获this
        function getAgeFromBirth() {
            var y = new Date().getFullYear();
            return y - that.birth; // 用that而不是this
        }
        return getAgeFromBirth();
    }
};

xiaoming.age(); // 25
```

用var that = this;，你就可以放心地在方法内部定义其他函数，而不是把所有语句都堆到一个方法中。

-   apply

虽然在一个独立的函数调用中，根据是否是strict模式，this指向undefined或window，不过，我们还是可以控制this的指向的！

要指定函数的this指向哪个对象，可以用函数本身的apply方法，它接收两个参数，第一个参数就是需要绑定的this变量，第二个参数是Array，表示函数本身的参数。

用apply修复getAge()调用：

```javascript
function getAge() {
    var y = new Date().getFullYear();
    return y - this.birth;
}

var xiaoming = {
    name: '小明',
    birth: 1990,
    age: getAge
};

xiaoming.age(); // 25
getAge.apply(xiaoming, []); // 25, this指向xiaoming, 参数为空
```

另一个与apply()类似的方法是call()，唯一区别是：

apply()把参数打包成Array再传入；

call()把参数按顺序传入。

比如调用Math.max(3, 5, 4)，分别用apply()和call()实现如下：

```javascript
Math.max.apply(null, [3, 5, 4]); // 5
Math.max.call(null, 3, 5, 4); // 5
```

对普通函数调用，我们通常把this绑定为null。

-   装饰器

利用apply()，我们还可以动态改变函数的行为。

JavaScript的所有对象都是动态的，即使内置的函数，我们也可以重新指向新的函数。

现在假定我们想统计一下代码一共调用了多少次parseInt()，可以把所有的调用都找出来，然后手动加上count += 1，不过这样做太傻了。最佳方案是用我们自己的函数替换掉默认的parseInt()：

```javascript
'use strict';

var count = 0;
var oldParseInt = parseInt; // 保存原函数

window.parseInt = function () {
    count += 1;
    return oldParseInt.apply(null, arguments); // 调用原函数
};
```

### 高阶函数

高阶函数英文叫Higher-order function。那么什么是高阶函数？

JavaScript的函数其实都指向某个变量。既然变量可以指向函数，函数的参数能接收变量，那么一个函数就可以接收另一个函数作为参数，这种函数就称之为高阶函数。

一个最简单的高阶函数：

```javascript
function add(x, y, f) {
    return f(x) + f(y);
}
```

当我们调用add(-5, 6, Math.abs)时，参数x，y和f分别接收-5，6和函数Math.abs，根据函数定义，我们可以推导计算过程为：

```javascript
x = -5;
y = 6;
f = Math.abs;
f(x) + f(y) ==> Math.abs(-5) + Math.abs(6) ==> 11;
return 11;
```

编写高阶函数，就是让函数的参数能够接收别的函数。

-   map/reduce

    如果你读过Google的那篇大名鼎鼎的论文“MapReduce: Simplified Data Processing on Large Clusters”，你就能大概明白map/reduce的概念。<br>
    **map**<br>
    举例说明，比如我们有一个函数f(x)=x2，要把这个函数作用在一个数组[1, 2, 3, 4, 5, 6, 7, 8, 9]上，就可以用map实现如下：<br>
    ![map](map.png)<br>
    由于map()方法定义在JavaScript的Array中，我们调用Array的map()方法，传入我们自己的函数，就得到了一个新的Array作为结果：

    ```javascript
    'use strict';

    function pow(x) {
        return x * x;
    }

    var arr = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    var results = arr.map(pow); // [1, 4, 9, 16, 25, 36, 49, 64, 81]
    console.log(results);
    ```

    注意：map()传入的参数是pow，即函数对象本身。

    你可能会想，不需要map()，写一个循环，也可以计算出结果：

    ```javascript
    var f = function (x) {
    return x * x;
    };

    var arr = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    var result = [];
    for (var i=0; i<arr.length; i++) {
        result.push(f(arr[i]));
    }
    ```

    的确可以，但是，从上面的循环代码，我们无法一眼看明白“把f(x)作用在Array的每一个元素并把结果生成一个新的Array”。

    所以，map()作为高阶函数，事实上它把运算规则抽象了，因此，我们不但可以计算简单的f(x)=x2，还可以计算任意复杂的函数，比如，把Array的所有数字转为字符串：

    ```javascript
    var arr = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    arr.map(String); // ['1', '2', '3', '4', '5', '6', '7', '8', '9']
    ```

    只需要一行代码。<br>
    **reduce**<br>
    再看reduce的用法。Array的reduce()把一个函数作用在这个Array的[x1, x2, x3...]上，这个函数必须接收两个参数，reduce()把结果继续和序列的下一个元素做累积计算，其效果就是：

    ```javascript
    [x1, x2, x3, x4].reduce(f) = f(f(f(x1, x2), x3), x4)
    ```

    比方说对一个Array求和，就可以用reduce实现：

    ```javascript
    var arr = [1, 3, 5, 7, 9];
    arr.reduce(function (x, y) {
        return x + y;
    }); // 25
    ```

-   filter
    filter也是一个常用的操作，它用于把Array的某些元素过滤掉，然后返回剩下的元素。

    和map()类似，Array的filter()也接收一个函数。和map()不同的是，filter()把传入的函数依次作用于每个元素，然后根据返回值是true还是false决定保留还是丢弃该元素。

    例如，在一个Array中，删掉偶数，只保留奇数，可以这么写：

    ```javascript
    var arr = [1, 2, 4, 5, 6, 9, 10, 15];
    var r = arr.filter(function (x) {
        return x % 2 !== 0;
    });
    r; // [1, 5, 9, 15]
    ```

    把一个Array中的空字符串删掉，可以这么写：

    ```javascript
    var arr = ['A', '', 'B', null, undefined, 'C', '  '];
    var r = arr.filter(function (s) {
        return s && s.trim(); // 注意：IE9以下的版本没有trim()方法
    });
    r; // ['A', 'B', 'C']
    ```

    可见用filter()这个高阶函数，关键在于正确实现一个“筛选”函数。<br>
    **回调函数**<br>
    filter()接收的回调函数，其实可以有多个参数。通常我们仅使用第一个参数，表示Array的某个元素。回调函数还可以接收另外两个参数，表示元素的位置和数组本身：

    ```javascript
    var arr = ['A', 'B', 'C'];
    var r = arr.filter(function (element, index, self) {
        console.log(element); // 依次打印'A', 'B', 'C'
        console.log(index); // 依次打印0, 1, 2
        console.log(self); // self就是变量arr
        return true;
    });
    ```

-   sort

    **排序算法**<br>
    排序也是在程序中经常用到的算法。无论使用冒泡排序还是快速排序，排序的核心是比较两个元素的大小。如果是数字，我们可以直接比较，但如果是字符串或者两个对象呢？直接比较数学上的大小是没有意义的，因此，比较的过程必须通过函数抽象出来。通常规定，对于两个元素x和y，如果认为x &lt; y，则返回-1，如果认为x == y，则返回0，如果认为x > y，则返回1，这样，排序算法就不用关心具体的比较过程，而是根据比较结果直接排序。
    JavaScript的Array的sort()方法就是用于排序的，但是排序结果可能让你大吃一惊：

    ```javascript
    // 看上去正常的结果:
    ['Google', 'Apple', 'Microsoft'].sort(); // ['Apple', 'Google', 'Microsoft'];

    // apple排在了最后:
    ['Google', 'apple', 'Microsoft'].sort(); // ['Google', 'Microsoft", 'apple']

    // 无法理解的结果:
    [10, 20, 1, 2].sort(); // [1, 10, 2, 20]
    ```

    第二个排序把apple排在了最后，是因为字符串根据ASCII码进行排序，而小写字母a的ASCII码在大写字母之后。

    第三个排序结果是什么鬼？简单的数字排序都能错？

    这是因为Array的sort()方法默认把所有元素先转换为String再排序，结果'10'排在了'2'的前面，因为字符'1'比字符'2'的ASCII码小。

    如果不知道sort()方法的默认排序规则，直接对数字排序，绝对栽进坑里！

    幸运的是，sort()方法也是一个高阶函数，它还可以接收一个比较函数来实现自定义的排序。

    要按数字大小排序，我们可以这么写：

    ```javascript
    'use strict';

    var arr = [10, 20, 1, 2];
    arr.sort(function (x, y) {
    if (x < y) {
        return -1;
    }
    if (x > y) {
        return 1;
    }
    return 0;
    });
    console.log(arr); // [1, 2, 10, 20]
    ```

    如果要倒序排序，我们可以把大的数放前面：

    ```javascript
    var arr = [10, 20, 1, 2];
    arr.sort(function (x, y) {
        if (x < y) {
            return 1;
        }
        if (x > y) {
            return -1;
        }
        return 0;
    }); // [20, 10, 2, 1]
    ```

    默认情况下，对字符串排序，是按照ASCII的大小比较的，现在，我们提出排序应该忽略大小写，按照字母序排序。要实现这个算法，不必对现有代码大加改动，只要我们能定义出忽略大小写的比较算法就可以：

    ```javascript
    var arr = ['Google', 'apple', 'Microsoft'];
    arr.sort(function (s1, s2) {
        x1 = s1.toUpperCase();
        x2 = s2.toUpperCase();
        if (x1 < x2) {
            return -1;
        }
        if (x1 > x2) {
            return 1;
        }
        return 0;
    }); // ['apple', 'Google', 'Microsoft']
    ```

    忽略大小写来比较两个字符串，实际上就是先把字符串都变成大写（或者都变成小写），再比较。

    从上述例子可以看出，高阶函数的抽象能力是非常强大的，而且，核心代码可以保持得非常简洁。

    最后友情提示，sort()方法会直接对Array进行修改，它返回的结果仍是当前Array：

    ```javascript
    var a1 = ['B', 'A', 'C'];
    var a2 = a1.sort();
    a1; // ['A', 'B', 'C']
    a2; // ['A', 'B', 'C']
    a1 === a2; // true, a1和a2是同一对象
    ```

### 闭包

**函数作为返回值**

高阶函数除了可以接受函数作为参数外，还可以把函数作为结果值返回。

我们来实现一个对Array的求和。通常情况下，求和的函数是这样定义的：

```javascript
function sum(arr) {
    return arr.reduce(function (x, y) {
        return x + y;
    });
}

sum([1, 2, 3, 4, 5]); // 15
```

但是，如果不需要立刻求和，而是在后面的代码中，根据需要再计算怎么办？可以不返回求和的结果，而是返回求和的函数！

```javascript
function lazy_sum(arr) {
    var sum = function () {
        return arr.reduce(function (x, y) {
            return x + y;
        });
    }
    return sum;
}
```

当我们调用lazy_sum()时，返回的并不是求和结果，而是求和函数：

```javascript
var f = lazy_sum([1, 2, 3, 4, 5]); // function sum()
```

调用函数f时，才真正计算求和的结果：

```javascript
f(); // 15
```

在这个例子中，我们在函数lazy_sum中又定义了函数sum，并且，内部函数sum可以引用外部函数lazy_sum的参数和局部变量，当lazy_sum返回函数sum时，相关参数和变量都保存在返回的函数中，这种称为“闭包（Closure）”的程序结构拥有极大的威力。

请再注意一点，当我们调用lazy_sum()时，每次调用都会返回一个新的函数，即使传入相同的参数：

```javascript
var f1 = lazy_sum([1, 2, 3, 4, 5]);
var f2 = lazy_sum([1, 2, 3, 4, 5]);
f1 === f2; // false
```

f1()和f2()的调用结果互不影响。

**闭包**

注意到返回的函数在其定义内部引用了局部变量arr，所以，当一个函数返回了一个函数后，其内部的局部变量还被新函数引用，所以，闭包用起来简单，实现起来可不容易。

另一个需要注意的问题是，返回的函数并没有立刻执行，而是直到调用了f()才执行。我们来看一个例子：

```javascript
function count() {
    var arr = [];
    for (var i=1; i<=3; i++) {
        arr.push(function () {
            return i * i;
        });
    }
    return arr;
}

var results = count();
var f1 = results[0];
var f2 = results[1];
var f3 = results[2];
```

在上面的例子中，每次循环，都创建了一个新的函数，然后，把创建的3个函数都添加到一个Array中返回了。

你可能认为调用f1()，f2()和f3()结果应该是1，4，9，但实际结果是：

```javascript
f1(); // 16
f2(); // 16
f3(); // 16
```

全部都是16！原因就在于返回的函数引用了变量i，但它并非立刻执行。等到3个函数都返回时，它们所引用的变量i已经变成了4，因此最终结果为16。

返回闭包时牢记的一点就是：返回函数不要引用任何循环变量，或者后续会发生变化的变量。

如果一定要引用循环变量怎么办？方法是再创建一个函数，用该函数的参数绑定循环变量当前的值，无论该循环变量后续如何更改，已绑定到函数参数的值不变：

```javascript
function count() {
    var arr = [];
    for (var i=1; i<=3; i++) {
        arr.push(
          (function (n) {
            return function () {
                return n * n;
              }
          })(i)
        );
    }
    return arr;
}

var results = count();
var f1 = results[0];
var f2 = results[1];
var f3 = results[2];

f1(); // 1
f2(); // 4
f3(); // 9
```

注意这里用了一个“创建一个匿名函数并立刻执行”的语法：

```javascript
(function (x) {
    return x * x;
})(3); // 9
```

理论上讲，创建一个匿名函数并立刻执行可以这么写：

```javascript
function (x) { return x * x } (3);
```

但是由于JavaScript语法解析的问题，会报SyntaxError错误，因此需要用括号把整个函数定义括起来：

```javascript
(function (x) { return x * x }) (3);
```

通常，一个立即执行的匿名函数可以把函数体拆开，一般这么写：

```javascript
(function (x) {
    return x * x;
})(3);
```

说了这么多，难道闭包就是为了返回一个函数然后延迟执行吗？

当然不是！闭包有非常强大的功能。举个栗子：

在面向对象的程序设计语言里，比如Java和C++，要在对象内部封装一个私有变量，可以用private修饰一个成员变量。

在没有class机制，只有函数的语言里，借助闭包，同样可以封装一个私有变量。我们用JavaScript创建一个计数器：

```javascript
'use strict';

function create_counter(initial) {
    var x = initial || 0;
    return {
        inc: function () {
            x += 1;
            return x;
        }
    }
}
```

它用起来像这样：

```javascript
var c1 = create_counter();
c1.inc(); // 1
c1.inc(); // 2
c1.inc(); // 3

var c2 = create_counter(10);
c2.inc(); // 11
c2.inc(); // 12
c2.inc(); // 13
```

在返回的对象中，实现了一个闭包，该闭包携带了局部变量x，并且，从外部代码根本无法访问到变量x。换句话说，闭包就是携带状态的函数，并且它的状态可以完全对外隐藏起来。

闭包还可以把多参数的函数变成单参数的函数。例如，要计算xy可以用Math.pow(x, y)函数，不过考虑到经常计算x2或x3，我们可以利用闭包创建新的函数pow2和pow3：

```javascript
'use strict';

function make_pow(n) {
    return function (x) {
        return Math.pow(x, n);
    }
}
// 创建两个新函数:
var pow2 = make_pow(2);
var pow3 = make_pow(3);

console.log(pow2(5)); // 25
console.log(pow3(7)); // 343
```

**脑洞大开**

很久很久以前，有个叫阿隆佐·邱奇的帅哥，发现只需要用函数，就可以用计算机实现运算，而不需要0、1、2、3这些数字和+、-、\*、/这些符号。

JavaScript支持函数，所以可以用JavaScript用函数来写这些计算。来试试：

```javascript
'use strict';

// 定义数字0:
var zero = function (f) {
    return function (x) {
        return x;
    }
};

// 定义数字1:
var one = function (f) {
    return function (x) {
        return f(x);
    }
};

// 定义加法:
function add(n, m) {
    return function (f) {
        return function (x) {
            return m(f)(n(f)(x));
        }
    }
}
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
