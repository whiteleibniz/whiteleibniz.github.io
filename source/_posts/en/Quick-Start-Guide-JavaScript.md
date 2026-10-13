---
title: Quick Start Guide JavaScript
date: 2018-07-18 06:09:18
lang: en
permalink: en/2018/07/18/Quick-Start-Guide-JavaScript/
tags:
- Quick Start Guide
- JavaScript
---

## Clarifying the Relationship Between JS, the Browser, and Node.js

| JavaScript | java   |
| :--------- | :----- |
| V8         | JVM    |
| node.js    | JRE    |
| browser    | Applet |

-   JavaScript: a scripting language
-   v8: (browser engine, Node.js engine) equivalent to the JVM in Java (a virtual machine bytecode interpreter)
-   node.js: file system I/O, networking (HTTP, TCP, UDP, DNS, TLS/SSL, etc.), binary data streams, encryption algorithms, data streams, and so on
-   browser: the Document Object Model (DOM) and the Browser Object Model (BOM). For security reasons, JS in the browser can only operate on DOM and BOM objects, so its capabilities are limited.

## Basic Syntax

### Program Comments

Characters starting with `//` until the end of the line are treated as a line comment. Comments are for developers to read; the JavaScript engine automatically ignores them:

```javascript
// 这是一行注释
alert('hello'); // 这也是注释
```

Another kind of block comment uses `/*...*/` to wrap multiple lines of characters, treating a large "block" as a single comment:

```javascript
/* 从这里开始是块注释
仍然是注释
仍然是注释
注释结束 */
```

### Variables

The concept of a variable is basically the same as that of an equation variable in middle school algebra, except that in computer programs, a variable can be not only a number but also any data type.

In JavaScript, a variable is represented by a variable name. A variable name is a combination of uppercase and lowercase letters, digits, `$`, and `_`, and it cannot start with a digit. A variable name also cannot be a JavaScript keyword, such as `if` or `while`. To declare a variable, use the `var` statement, for example:

```javascript
var a; // 申明了变量a，此时a的值为undefined
var $b = 1; // 申明了变量$b，同时给$b赋值，此时$b的值为1
var s_007 = '007'; // s_007是一个字符串
var Answer = true; // Answer是一个布尔值true
var t = null; // t的值是null
```

### Variable Types

-   Number
      JavaScript has only one number type. Numbers can have a decimal point or not:
    ```javascript
    var x1=123; // 整数123
    var x2=0.456; // 浮点数0.456
    var x3=1.2345e3; // 科学计数法表示1.2345x1000，等同于1234.5
    var x4=-99; // 负数
    var x5=NaN; // NaN表示Not a Number，当无法计算结果时用NaN表示
    var x6=Infinity; // Infinity表示无限大，当数值超过了JavaScript的Number所能表示的最大值时，就表示为Infinity
    ```
-   String
    A string is any text enclosed in single quotes ' or double quotes ", such as `'abc'` or `"xyz"`. Please note that `''` or `""` itself is only a notation and is not part of the string. Therefore, the string `'abc'` contains only the 3 characters `a`, `b`, and `c`.

    ```javascript
    var answer="Nice to meet you!";
    var answer="He is called 'Bill'";
    var answer='He is called "Bill"';
    ```

-   Boolean
    A Boolean (logical) value can only have two values: true or false.

    ```javascript
    var x=true
    var y=false
    ```

-   Array
    An array is an ordered collection, and each value in the collection is called an element. A JavaScript array can include any data type. For example:
    ```javascript
    [1, 2, 3.14, 'Hello', null, true];
    ```
-   Map
    A Map is a structure of key-value pairs with extremely fast lookup speed.

    ```javascript
    var m = new Map([['Michael', 95], ['Bob', 75], ['Tracy', 85]]);
    m.get('Michael'); // 95
    ```

    Initializing a Map requires a two-dimensional array, or you can directly initialize an empty Map. A Map has the following methods:

    ```javascript
    var m = new Map(); // 空Map
    m.set('Adam', 67); // 添加新的key-value
    m.set('Bob', 59);
    m.has('Adam'); // 是否存在key 'Adam': true
    m.get('Adam'); // 67
    m.delete('Adam'); // 删除key 'Adam'
    m.get('Adam'); // undefined
    ```

    Since a key can correspond to only one value, putting a value into the same key multiple times will cause the later value to overwrite the earlier one:

    ```javascript
    var m = new Map();
    m.set('Adam', 67);
    m.set('Adam', 88);
    m.get('Adam'); // 88
    ```

-   Set

    A Set is similar to a Map: it is also a collection of keys, but it does not store values. Since keys cannot be repeated, there are no duplicate keys in a Set.
    To create a Set, you need to provide an Array as input, or directly create an empty Set:

    ```JavaScript
    var s1 = new Set(); // 空Set
    var s2 = new Set([1, 2, 3]); // 含1, 2, 3
    ```

    Duplicate elements are automatically filtered out in a Set:

    ```javascript
    var s = new Set([1, 2, 3, 3, '3']);
    s; // Set {1, 2, 3, "3"}
    ```

    Note that the number 3 and the string '3' are different elements.
    Elements can be added to a Set through the add(key) method. Adding repeatedly is allowed, but it has no effect:

    ```javascript
    s.add(4);
    s; // Set {1, 2, 3, 4}
    s.add(4);
    s; // 仍然是 Set {1, 2, 3, 4}
    ```

    Elements can be deleted through the delete(key) method:

    ```javascript
    var s = new Set([1, 2, 3]);
    s; // Set {1, 2, 3}
    s.delete(3);
    s; // Set {1, 2}
    ```

-   Object

    A JavaScript object is an unordered collection of key-value pairs, for example:

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

    The keys of a JavaScript object are all of the string type, and the values can be of any data type. The `person` object above defines a total of 6 key-value pairs, in which each key is also called a property of the object. For example, the `name` property of `person` is `'Bob'`, and the `zipcode` property is `null`.
    To obtain a property of an object, we use the form `objectVariable.propertyName`:

    ```javascript
    person.name; // 'Bob'
    person.zipcode; // null
    ```

-   Undefined and Null

    null represents an "empty" value. It is different from 0 and the empty string '': 0 is a numeric value, '' represents a string of length 0, and null represents "empty".

    Other languages also have representations similar to JavaScript's null. For example, Java also uses null, Swift uses nil, and Python uses None. However, in JavaScript there is also an undefined that is similar to null, and it represents "undefined".

    The designers of JavaScript intended null to represent an empty value and undefined to represent a value that is not defined. In practice, this has proved to be of little use, and there is not much point in distinguishing the two. In most cases, we should use null. undefined is useful only for determining whether a function argument has been passed.

-   strict Mode

    When JavaScript was first designed, in order to make it easier for beginners to learn, it did not force variables to be declared with var. This design mistake has brought serious consequences: if a variable is used without being declared with var, the variable is automatically declared as a global variable:

    ```javascript
    i = 10; // i现在是全局变量
    ```

    In different JavaScript files on the same page, if none of them declare the variable with var and all happen to use the variable i, the variable i will affect each other, producing error results that are difficult to debug.

    Variables declared with var are not global variables. Their scope is limited to the function body in which the variable is declared (the concept of functions will be explained later), and variables with the same name in different function bodies do not conflict with each other.

    To fix this serious design flaw of JavaScript, ECMA introduced strict mode in subsequent specifications. JavaScript code running in strict mode is forced to declare variables with var; using a variable without declaring it with var will cause a runtime error.

    To enable strict mode, write the following on the first line of the JavaScript code:

    ```javascript
    'use strict';
    ```

    This is a string. A browser that does not support strict mode will execute it as a string statement, while a browser that supports strict mode will enable strict mode to run JavaScript.

### Constants

Since var and let declare variables, it was not possible to declare a constant before ES6. We usually use an all-uppercase variable to indicate "this is a constant; do not modify its value":

```javascript
var PI = 3.14;
```

The ES6 standard introduced the new keyword const to define constants. Both const and let have block scope:

```javascript
'use strict';

const PI = 3.14;
PI = 3; // 某些浏览器不报错，但是无效果！
PI; // 3.14
```

### Operators

-   The + Operator

    In JavaScript, the + operator has two uses: one is addition in the mathematical sense, and the other is string concatenation.

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

-   JavaScript Arithmetic Operators

    Arithmetic operators are used to perform arithmetic operations between variables and/or values.
    Given y=5, the following table explains these arithmetic operators:

| Operator | Description | Example | Result |
| --- | ---------- | ------ | ----- |
| +   | Addition    | x=y+2  | x=7   |
| -   | Subtraction | x=y-2  | x=3   |
| \*  | Multiplication | x=y\*2 | x=10  |
| /   | Division    | x=y/2  | x=2.5 |
| %   | Remainder (integer) | x=y%2  | x=y%2 |
| ++  | Increment   | x=++y  | x=6   |
| --  | Decrement   | x=--y  | x=4   |

-   JavaScript Assignment Operators

    Assignment operators are used to assign values to JavaScript variables.
    Given x=10 and y=5, the following table explains the assignment operators:

| Operator | Example | Equivalent To | Result |
| --- | ----- | ------ | ---- |
| =   | x=y   |        | x=5  |
| +=  | x+=y  | x=x+y  | x=15 |
| -=  | x-=y  | x=x-y  | x=5  |
| \*= | x\*=y | x=x\*y | x=50 |
| /=  | x/=y  | x=x/y  | x=2  |
| %=  | x%=y  | x=x%y  | x=0  |

-   JavaScript Comparison Operators

    Comparison operators are used in logical statements to determine whether variables or values are equal.
    Given x=5, the following table explains the comparison operators:

| Operator |     | Description | Example |
| ----- | --- | -------- | ---------------------------- |
| ==    |     | Equal to    | x==8 is false |
| ===   |     | Strictly equal (value and type) | x===5 is true; x==="5" is false |
| !=    |     | Not equal to | x!=8 is true |
| >     |     | Greater than | x>8 is false |
| &lt;  |     | Less than | x&lt;8 is true |
| >=    |     | Greater than or equal to | x>=8 is false |
| &lt;= |     | Less than or equal to | x&lt;=8 is true |

-   JavaScript Logical Operators

    Logical operators are used to determine the logic between variables or values.
    Given x=6 and y=3, the following table explains the logical operators:

| Operator | Description | Example |
| ---- | --- | --------------------------- |
| &&   | and | (x &lt; 10 && y > 1) is true |
| \|\| | or  | (x==5\|\|y==5) is false      |
| !    | not | !(x==y) is true              |

-   JavaScript Conditional Operator

    JavaScript also includes a conditional operator that assigns values to variables based on certain conditions.

    ```javascript
    variablename=(condition)?value1:value2
    ```

### Expressions

## Control Flow Structures

### Branching Structures

-   if statement - use this statement to execute code only when the specified condition is true

    ```javascript
    if (time<20)
    {
    x="Good day";
    }
    ```

-   if...else statement - execute code when the condition is true, and execute other code when the condition is false

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

-   if...else if...else statement - use this statement to select one of multiple code blocks to execute

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

-   switch statement - use this statement to select one of multiple code blocks to execute

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

-   default keyword - use the default keyword to specify what to do when no match exists

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

### Loop Structures

-   for - loop a code block a certain number of times

    ```javascript
    for (var i=0; i<5; i++)
      {
      x=x + "The number is " + i + "<br>";
      }
    ```

-   for/in - loop through the properties of an object

    ```javascript
    var person={fname:"John",lname:"Doe",age:25};
    for (x in person)
      {
      txt=txt + person[x];
      }
    ```

-   for/of - a collection with an iterable type can be traversed through the new for/of loop.

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

-   forEach() - it accepts a function and automatically calls back that function on each iteration

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

-   while - loop the specified code block while the specified condition is true

    ```javascript
    while (i<5)
    {
    x=x + "The number is " + i + "<br>";
    i++;
    }
    ```

-   do/while - likewise loop the specified code block while the specified condition is true

    ```javascript
    do
      {
      x=x + "The number is " + i + "<br>";
      i++;
      }
    while (i<5);
    ```

### Special Control Flow Statements

-   Break Statement

    We have already seen the break statement in switch. It is used to break out of the switch() statement.
    The break statement can be used to break out of a loop.
    After the break statement breaks out of the loop, the code after the loop (if any) continues to execute:

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

-   Continue Statement

    The continue statement interrupts the iteration in the loop if the specified condition occurs, and then continues with the next iteration in the loop.
    This example skips the value 3:

    ```javascript
    for (i=0;i<=10;i++)
    {
    if (i==3) continue;
    x=x + "The number is " + i + "<br>";
    }
    ```

## Functions

With the help of abstraction, we can ignore the underlying concrete calculation process and think about problems directly at a higher level.
The same applies to writing computer programs: a function is the most basic form of code abstraction.

### Function Definition and Invocation

-   Definition

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

    A JavaScript function is also an object. The `abs()` function defined above is actually a function object, and the function name `abs` can be regarded as a variable pointing to that function.

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

-   Invocation

    ```javascript
    abs(10); // 返回10
    abs(-9); // 返回9
    ```

-   arguments

    JavaScript also throws in a free keyword, arguments. It only works inside a function, and it always refers to all the arguments passed by the caller of the current function. arguments is similar to an Array but it is not an Array:
    With arguments, you can obtain all the arguments passed by the caller. That is, even if the function does not define any arguments, you can still get the values of the arguments:

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

-   rest Parameters
    Since JavaScript functions allow receiving any number of arguments, we have to use arguments to get all the arguments:

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

    In order to get the arguments other than the already defined arguments a and b, we have to use arguments, and the loop has to start from index 2 in order to exclude the first two arguments. This way of writing is awkward just to get the extra rest arguments. Is there a better way?

    The ES6 standard introduced rest parameters. The function above can be rewritten as:

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

    A rest parameter can only be written at the end and is marked with ... in front. From the running results, it can be seen that the passed arguments are first bound to a and b, and the extra arguments are handed to the variable rest in the form of an array. Therefore, we get all the arguments without needing arguments.

    If the passed arguments do not even fill up the normally defined arguments, that is fine: the rest parameter will receive an empty array (note: not undefined).

### Variable Scope and Destructuring Assignment

In JavaScript, variables declared with var actually have scope.
If a variable is declared inside a function body, its scope is the entire function body, and the variable cannot be referenced outside the function body:

-   Local JavaScript Variables

    ```javascript
    'use strict';

    function foo() {
        var x = 1;
        x = x + 1;
    }

    x = x + 2; // ReferenceError! 无法在函数体外引用变量x
    ```

-   Variable Hoisting

    The function definition in JavaScript has a special feature: it first scans the statements of the entire function body and "hoists" all declared variables to the top of the function:

    ```javascript
    'use strict';

    function foo() {
        var x = 'Hello, ' + y;
        console.log(x);
        var y = 'Bob';
    }

    foo();
    ```

    Although this is strict mode, the statement var x = 'Hello, ' + y; does not raise an error, because the variable y is declared later. However, console.log displays Hello, undefined, which shows that the value of the variable y is undefined. This is precisely because the JavaScript engine automatically hoists the declaration of the variable y, but does not hoist the assignment of the variable y.

    For the foo() function above, the code seen by the JavaScript engine is equivalent to:

    ```javascript
    function foo() {
    var y; // 提升变量y的申明，此时y为undefined
    var x = 'Hello, ' + y;
    console.log(x);
    y = 'Bob';
    }
    ```

    Because of this bizarre "feature" of JavaScript, when defining variables inside a function, please strictly follow the rule "**declare all variables first inside the function**". The most common practice is to use a single var to declare all the variables used inside the function:

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


-   Global JavaScript Variables
    Variables that are not defined inside any function have global scope. In fact, JavaScript has a global object window by default, and variables with global scope are actually bound to a property of window:

    ```javascript
    'use strict';

    var course = 'Learn JavaScript';
    alert(course); // 'Learn JavaScript'
    alert(window.course); // 'Learn JavaScript'
    ```

    Therefore, directly accessing the global variable course and accessing window.course are exactly the same.

    You may have guessed that, since there are two ways to define a function, a function defined as a variable with var foo = function () {} is actually also a global variable. Therefore, the definition of a top-level function is also treated as a global variable and bound to the window object:

    ```javascript
    'use strict';

    function foo() {
        alert('foo');
    }

    foo(); // 直接调用foo()
    window.foo(); // 通过window.foo()调用
    ```

    To make a bolder guess, the alert() function that we call directly every time is actually also a variable of window:

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

    This shows that JavaScript actually has only one global scope. For any variable (a function is also treated as a variable), if it is not found in the current function scope, the search continues upward. Finally, if it is not found in the global scope either, a ReferenceError is raised.

-   Namespace
    Global variables are bound to window. If different JavaScript files use the same global variables, or define top-level functions with the same names, naming conflicts will occur, and they are difficult to detect.

    One way to reduce conflicts is to bind all of your own variables and functions to a single global variable. For example:

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

    Putting all of your own code into the unique namespace MYAPP will greatly reduce the possibility of global variable conflicts.

    Many famous JavaScript libraries do exactly this: jQuery, YUI, underscore, and so on.

-   Local Scope

    Since the variable scope in JavaScript is actually inside the function, we cannot define variables with local scope in statement blocks such as the for loop:

    ```javascript
    'use strict';

    function foo() {
        for (var i=0; i<100; i++) {
            //
        }
        i += 100; // 仍然可以引用变量i
    }
    ```

    To address block scope, ES6 introduced the new keyword let. Replacing var with let allows declaring a variable with block scope:

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

-   Destructuring Assignment

    Starting from ES6, JavaScript introduced destructuring assignment, which allows assigning values to a group of variables at the same time.

    What is destructuring assignment? Let's first look at the traditional approach: how to assign the elements of an array to several variables separately:

    ```javascript
    var array = ['hello', 'JavaScript', 'ES6'];
    var x = array[0];
    var y = array[1];
    var z = array[2];
    ```

    Now, in ES6, you can use destructuring assignment to assign values to multiple variables at the same time:

    ```javascript
    'use strict';

    // 如果浏览器支持解构赋值就不会报错:
    var [x, y, z] = ['hello', 'JavaScript', 'ES6'];
    ```

    Note that when performing destructuring assignment on array elements, multiple variables must be enclosed in [...].

    If the array itself is nested, destructuring assignment can also be performed in the following form. Note that the nesting levels and positions must be consistent:

    ```javascript
    let [x, [y, z]] = ['hello', ['JavaScript', 'ES6']];
    x; // 'hello'
    y; // 'JavaScript'
    z; // 'ES6'
    ```

    Destructuring assignment can also ignore certain elements:

    ```javascript
    let [, , z] = ['hello', 'JavaScript', 'ES6']; // 忽略前两个元素，只对z赋值第三个元素
    z; // 'ES6'
    ```

    If you need to extract several properties from an object, you can also use destructuring assignment, which makes it easy to quickly obtain the specified properties of the object:

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

    When performing destructuring assignment on an object, you can also directly assign values to nested object properties, as long as the corresponding levels are consistent:

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

    When using destructuring assignment to assign values to object properties, if the corresponding property does not exist, the variable will be assigned undefined, which is consistent with referencing a non-existent property to get undefined. If the variable name to be used is different from the property name, you can use the following syntax to obtain it:

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

    Destructuring assignment can also use default values, which avoids the problem of a non-existent property returning undefined:

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

    Sometimes, if the variables have already been declared, the correct way of writing will also raise a syntax error when assigning values again:

    ```javascript
    // 声明变量:
    var x, y;
    // 解构赋值:
    {x, y} = { name: '小明', x: 100, y: 200};
    // 语法错误: Uncaught SyntaxError: Unexpected token =
    ```

    This is because the JavaScript engine treats a statement starting with { as a block, so = is no longer valid. The solution is to enclose it in parentheses:

    ```javascript
    ({x, y} = { name: '小明', x: 100, y: 200});
    ```

### Methods

Binding a function in an object is called a method of that object.

In JavaScript, an object is defined like this:

```javascript
var xiaoming = {
    name: '小明',
    birth: 1990
};
```

However, if we bind a function to xiaoming, we can do more things. For example, write an age() method that returns the age of xiaoming:

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

A function bound to an object is called a method. It is no different from an ordinary function, except that it uses a this keyword internally. What is this thing?

Inside a method, this is a special variable that always points to the current object, that is, the xiaoming variable. Therefore, this.birth can get the birth property of xiaoming.

Let's write it separately:

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

Why does calling the getAge() function alone return NaN? Please note that we have now entered a big pit of JavaScript.

If this is called inside a JavaScript function, then who exactly does this point to?

The answer is: it depends!

If it is called in the form of an object's method, such as xiaoming.age(), the this of the function points to the object being called, that is, xiaoming, which is what we expect.

If the function is called alone, such as getAge(), then the this of the function points to the global object, that is, window.

What a trap!

What is even nastier is this:

```javascript
var fn = xiaoming.age; // 先拿到xiaoming的age函数
fn(); // NaN
```

This also does not work! To ensure that this points correctly, you must call it in the form of obj.xxx()!

Since this is a huge design mistake, it is not so easy to correct. ECMA decided to make the this of a function point to undefined in strict mode. Therefore, in strict mode, you will get an error:

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

This decision only makes the error surface in time; it does not solve where this should point.

Sometimes, you who like refactoring refactor the method a bit:

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

An error is raised again! The reason is that the this pointer points to xiaoming only inside the function of the age method. For a function defined inside a function, this points to undefined again! (In non-strict mode, it points to the global object window again!)

There is a way to fix this. We use a that variable to capture this first:

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

With var that = this;, you can safely define other functions inside a method, instead of piling all the statements into a single method.

-   apply

Although in an independent function call, this points to undefined or window depending on whether it is strict mode, we can still control where this points!

To specify which object the this of a function points to, you can use the apply method of the function itself. It takes two arguments: the first is the this variable that needs to be bound, and the second is an Array, representing the arguments of the function itself.

Use apply to fix the getAge() invocation:

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

Another method similar to apply() is call(), and the only difference is:

apply() packs the arguments into an Array and then passes them in;

call() passes the arguments in order.

For example, to call Math.max(3, 5, 4), the implementations using apply() and call() are as follows:

```javascript
Math.max.apply(null, [3, 5, 4]); // 5
Math.max.call(null, 3, 5, 4); // 5
```

For ordinary function calls, we usually bind this to null.

-   Decorator

Using apply(), we can also dynamically change the behavior of a function.

All objects in JavaScript are dynamic. Even built-in functions can be re-pointed to new functions.

Now suppose we want to count how many times parseInt() is called in total in the code. We could find all the calls and manually add count += 1, but that would be too silly. The best approach is to replace the default parseInt() with our own function:

```javascript
'use strict';

var count = 0;
var oldParseInt = parseInt; // 保存原函数

window.parseInt = function () {
    count += 1;
    return oldParseInt.apply(null, arguments); // 调用原函数
};
```

### Higher-Order Functions

Higher-order functions are called Higher-order functions in English. So what is a higher-order function?

In fact, all functions in JavaScript point to some variable. Since a variable can point to a function, and the arguments of a function can receive variables, a function can receive another function as an argument. This kind of function is called a higher-order function.

The simplest higher-order function:

```javascript
function add(x, y, f) {
    return f(x) + f(y);
}
```

When we call add(-5, 6, Math.abs), the arguments x, y, and f receive -5, 6, and the function Math.abs respectively. According to the function definition, we can deduce the calculation process as follows:

```javascript
x = -5;
y = 6;
f = Math.abs;
f(x) + f(y) ==> Math.abs(-5) + Math.abs(6) ==> 11;
return 11;
```

Writing a higher-order function means making the arguments of a function able to receive other functions.

-   map/reduce

    If you have read Google's famous paper "MapReduce: Simplified Data Processing on Large Clusters", you can roughly understand the concept of map/reduce.<br>
    **map**<br>
    For example, suppose we have a function f(x)=x2 and want to apply it to an array [1, 2, 3, 4, 5, 6, 7, 8, 9]. This can be achieved with map as follows:<br>
    ![map](map.png)<br>
    Since the map() method is defined in JavaScript's Array, we call the map() method of the Array and pass in our own function, and we get a new Array as the result:

    ```javascript
    'use strict';

    function pow(x) {
        return x * x;
    }

    var arr = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    var results = arr.map(pow); // [1, 4, 9, 16, 25, 36, 49, 64, 81]
    console.log(results);
    ```

    Note: the argument passed to map() is pow, that is, the function object itself.

    You might think that you can also calculate the result by writing a loop, without using map():

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

    This is indeed possible. However, from the loop code above, we cannot tell at a glance that it is meant to "apply f(x) to every element of the Array and generate a new Array from the result".

    Therefore, map(), as a higher-order function, in fact abstracts the operation rules. Thus, we can calculate not only a simple f(x)=x2, but also any arbitrarily complex function, for example, converting all the numbers of an Array into strings:

    ```javascript
    var arr = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    arr.map(String); // ['1', '2', '3', '4', '5', '6', '7', '8', '9']
    ```

    Only one line of code is needed.<br>
    **reduce**<br>
    Now let's look at the usage of reduce. The reduce() of an Array applies a function to the [x1, x2, x3...] of this Array. This function must accept two arguments, and reduce() continues to accumulate the result with the next element of the sequence. The effect is as follows:

    ```javascript
    [x1, x2, x3, x4].reduce(f) = f(f(f(x1, x2), x3), x4)
    ```

    For example, to sum an Array, you can use reduce:

    ```javascript
    var arr = [1, 3, 5, 7, 9];
    arr.reduce(function (x, y) {
        return x + y;
    }); // 25
    ```

-   filter
    filter is also a commonly used operation. It is used to filter out certain elements of an Array and then return the remaining elements.

    Similar to map(), the filter() of an Array also accepts a function. Unlike map(), filter() applies the passed function to each element in turn, and then decides whether to keep or discard the element based on whether the return value is true or false.

    For example, to remove even numbers from an Array and keep only odd numbers, you can write it like this:

    ```javascript
    var arr = [1, 2, 4, 5, 6, 9, 10, 15];
    var r = arr.filter(function (x) {
        return x % 2 !== 0;
    });
    r; // [1, 5, 9, 15]
    ```

    To remove the empty strings from an Array, you can write it like this:

    ```javascript
    var arr = ['A', '', 'B', null, undefined, 'C', '  '];
    var r = arr.filter(function (s) {
        return s && s.trim(); // 注意：IE9以下的版本没有trim()方法
    });
    r; // ['A', 'B', 'C']
    ```

    As you can see, the key to using the higher-order function filter() is to correctly implement a "filter" function.<br>
    **Callback Functions**<br>
    The callback function accepted by filter() can actually have multiple arguments. Usually we use only the first argument, which represents a certain element of the Array. The callback function can also accept two other arguments, representing the position of the element and the array itself:

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

    **Sorting Algorithms**<br>
    Sorting is also an algorithm frequently used in programs. Whether using bubble sort or quick sort, the core of sorting is to compare the sizes of two elements. If they are numbers, we can compare them directly, but what if they are strings or two objects? Directly comparing mathematical magnitudes is meaningless, so the comparison process must be abstracted through a function. It is usually stipulated that for two elements x and y, if x < y, return -1; if x == y, return 0; and if x > y, return 1. This way, the sorting algorithm does not need to care about the specific comparison process, but can sort directly according to the comparison results.
    The sort() method of JavaScript's Array is used for sorting, but the sorting results may surprise you:

    ```javascript
    // 看上去正常的结果:
    ['Google', 'Apple', 'Microsoft'].sort(); // ['Apple', 'Google', 'Microsoft'];

    // apple排在了最后:
    ['Google', 'apple', 'Microsoft'].sort(); // ['Google', 'Microsoft", 'apple']

    // 无法理解的结果:
    [10, 20, 1, 2].sort(); // [1, 10, 2, 20]
    ```

    The second sort puts apple at the end, because strings are sorted according to ASCII codes, and the ASCII code of the lowercase letter a comes after that of uppercase letters.

    What on earth is the result of the third sort? Can a simple numeric sort be wrong?

    This is because the sort() method of an Array converts all elements to String first and then sorts them by default. As a result, '10' comes before '2', because the ASCII code of the character '1' is smaller than that of the character '2'.

    If you do not know the default sorting rules of the sort() method and sort numbers directly, you will definitely fall into a pit!

    Fortunately, the sort() method is also a higher-order function, and it can also accept a comparison function to implement custom sorting.

    To sort by numeric size, we can write it like this:

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

    If you want to sort in reverse order, you can put the larger numbers first:

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

    By default, strings are sorted by comparing ASCII sizes. Now we propose that sorting should ignore case and follow alphabetical order. To implement this algorithm, there is no need to make major changes to the existing code, as long as we can define a case-insensitive comparison algorithm:

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

    Comparing two strings case-insensitively actually means first converting all the strings to uppercase (or all to lowercase), and then comparing them.

    From the above examples, it can be seen that the abstraction ability of higher-order functions is very powerful, and the core code can be kept very concise.

    Finally, a friendly reminder: the sort() method modifies the Array directly, and the result it returns is still the current Array:

    ```javascript
    var a1 = ['B', 'A', 'C'];
    var a2 = a1.sort();
    a1; // ['A', 'B', 'C']
    a2; // ['A', 'B', 'C']
    a1 === a2; // true, a1和a2是同一对象
    ```

### Closures

**Functions as Return Values**

Besides being able to accept functions as arguments, a higher-order function can also return a function as the result value.

Let's implement a sum over an Array. Normally, the sum function is defined like this:

```javascript
function sum(arr) {
    return arr.reduce(function (x, y) {
        return x + y;
    });
}

sum([1, 2, 3, 4, 5]); // 15
```

But what if you do not need to sum immediately, but instead calculate later in the code as needed? You can return not the result of the sum, but the function that performs the sum!

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

When we call lazy_sum(), what is returned is not the result of the sum, but the function that performs the sum:

```javascript
var f = lazy_sum([1, 2, 3, 4, 5]); // function sum()
```

Only when the function f is called is the result of the sum actually calculated:

```javascript
f(); // 15
```

In this example, we define the function sum inside the function lazy_sum, and the inner function sum can reference the arguments and local variables of the outer function lazy_sum. When lazy_sum returns the function sum, the related arguments and variables are all saved in the returned function. This program structure, called a "closure", has great power.

Please note one more point: when we call lazy_sum(), each call returns a new function, even if the same arguments are passed in:

```javascript
var f1 = lazy_sum([1, 2, 3, 4, 5]);
var f2 = lazy_sum([1, 2, 3, 4, 5]);
f1 === f2; // false
```

The results of calling f1() and f2() do not affect each other.

**Closures**

Note that the returned function references the local variable arr inside its definition. Therefore, after a function returns a function, its internal local variables are still referenced by the new function. So closures are simple to use, but not easy to implement.

Another issue to note is that the returned function is not executed immediately; it is executed only when f() is called. Let's look at an example:

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

In the above example, each iteration creates a new function, and then the 3 created functions are all added to an Array and returned.

You might think that calling f1(), f2(), and f3() should give 1, 4, and 9, but the actual results are:

```javascript
f1(); // 16
f2(); // 16
f3(); // 16
```

They are all 16! The reason is that the returned functions reference the variable i, but they are not executed immediately. By the time all 3 functions are returned, the variable i they reference has already become 4, so the final result is 16.

One thing to keep in mind when returning closures is: do not reference any loop variables, or variables that will change later, in the returned function.

What if you must reference a loop variable? The method is to create another function and use its arguments to bind the current value of the loop variable. No matter how the loop variable changes later, the value already bound to the function argument does not change:

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

Note that the syntax used here is "create an anonymous function and execute it immediately":

```javascript
(function (x) {
    return x * x;
})(3); // 9
```

In theory, creating an anonymous function and executing it immediately can be written like this:

```javascript
function (x) { return x * x } (3);
```

However, due to JavaScript syntax parsing issues, a SyntaxError will be raised, so the entire function definition needs to be enclosed in parentheses:

```javascript
(function (x) { return x * x }) (3);
```

Usually, an immediately executed anonymous function can have its function body split apart, and is generally written like this:

```javascript
(function (x) {
    return x * x;
})(3);
```

Having said so much, is a closure just for returning a function and then delaying its execution?

Of course not! Closures have very powerful features. Let me give an example:

In object-oriented programming languages, such as Java and C++, to encapsulate a private variable inside an object, you can use private to modify a member variable.

In a language that has no class mechanism and only functions, with the help of closures, you can also encapsulate a private variable. Let's create a counter in JavaScript:

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

It is used like this:

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

In the returned object, a closure is implemented. This closure carries the local variable x, and the variable x is completely inaccessible from external code. In other words, a closure is a function that carries state, and its state can be completely hidden from the outside.

Closures can also turn a multi-argument function into a single-argument function. For example, to calculate xy, you can use the Math.pow(x, y) function. However, considering that x2 or x3 is often calculated, we can use closures to create the new functions pow2 and pow3:

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

**Wild Imagination**

A long, long time ago, a handsome guy named Alonzo Church discovered that by using only functions, computations could be implemented on a computer, without the need for numbers like 0, 1, 2, 3 and symbols like +, -, *, /.

JavaScript supports functions, so these calculations can be written using functions in JavaScript. Let's give it a try:

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

### Arrow Functions

The ES6 standard added a new kind of function: the Arrow Function.

Why is it called an Arrow Function? Because its definition uses an arrow:

```javascript
x => x * x
```

The arrow function above is equivalent to:

```javascript
function (x) {
    return x * x;
}
```

An arrow function is equivalent to an anonymous function and simplifies the function definition. There are two formats of arrow functions: one is like the one above, which contains only a single expression, omitting even { ... } and return. The other can contain multiple statements, in which case { ... } and return cannot be omitted:

```javascript
x => {
    if (x > 0) {
        return x * x;
    }
    else {
        return - x * x;
    }
}
```

If there is more than one argument, they need to be enclosed in parentheses ():

```javascript
// 两个参数:
(x, y) => x * x + y * y

// 无参数:
() => 3.14

// 可变参数:
(x, y, ...rest) => {
    var i, sum = x + y;
    for (i=0; i<rest.length; i++) {
        sum += rest[i];
    }
    return sum;
}
```

If you want to return an object, note that if it is a single expression, writing it like this will raise an error:

```javascript
// SyntaxError:
x => { foo: x }
```

Because it conflicts with the syntax of the { ... } of the function body, it needs to be changed to:

```javascript
// ok:
x => ({ foo: x })
```

**this**

An arrow function looks like a shorthand for an anonymous function, but in fact there is an obvious difference between an arrow function and an anonymous function: the this inside an arrow function is lexically scoped and determined by the context.

Recalling the previous examples, due to JavaScript's incorrect handling of this binding, the following example does not produce the expected result:

```javascript
var obj = {
    birth: 1990,
    getAge: function () {
        var b = this.birth; // 1990
        var fn = function () {
            return new Date().getFullYear() - this.birth; // this指向window或undefined
        };
        return fn();
    }
};
```

Now, arrow functions have completely fixed the pointing of this. this always points to the lexical scope, that is, the outer caller obj:

```javascript
var obj = {
    birth: 1990,
    getAge: function () {
        var b = this.birth; // 1990
        var fn = () => new Date().getFullYear() - this.birth; // this指向obj对象
        return fn();
    }
};
obj.getAge(); // 25
```

If you use arrow functions, the old hack of writing:

```javascript
var that = this;
```

is no longer needed.

Since this is already bound according to the lexical scope in arrow functions, when calling an arrow function with call() or apply(), this cannot be bound; that is, the first argument passed in is ignored:

```javascript
var obj = {
    birth: 1990,
    getAge: function (year) {
        var b = this.birth; // 1990
        var fn = (y) => y - this.birth; // this.birth仍是1990
        return fn.call({birth:2000}, year);
    }
};
obj.getAge(2015); // 25
```

### generator

The generator is a new data type introduced by the ES6 standard. A generator looks like a function, but it can return multiple times.

The people who defined the generator standard in ES6 borrowed the concept and syntax of Python's generator. If you are very familiar with Python's generator, then ES6's generator is a piece of cake. If you are not yet familiar with Python, hurry up and cram the Python tutorial!

Let's first review the concept of a function. A function is a complete piece of code. Calling a function means passing in arguments and then returning a result:

```javascript
function foo(x) {
    return x + x;
}

var r = foo(1); // 调用foo函数
```

During the execution of a function, if no return statement is encountered (if there is no return at the end of the function, it implies return undefined;), control cannot be returned to the calling code.

A generator is very similar to a function and is defined as follows:

```javascript
function* foo(x) {
    yield x + 1;
    yield x + 2;
    return x + 3;
}
```

The difference between a generator and a function is that a generator is defined with function* (note the extra *), and, besides the return statement, it can return multiple times using yield.

Most people are immediately dizzy: a generator is just a "function" that can return multiple times? What is the use of returning multiple times?

Let me give another example.

Let's take the famous Fibonacci sequence as an example. It starts with 0 and 1:

```javascript
0 1 1 2 3 5 8 13 21 34 ...
```

To write a function that produces the Fibonacci sequence, you can write it like this:

```javascript
function fib(max) {
    var
        t,
        a = 0,
        b = 1,
        arr = [0, 1];
    while (arr.length < max) {
        [a, b] = [b, a + b];
        arr.push(b);
    }
    return arr;
}

// 测试:
fib(5); // [0, 1, 1, 2, 3]
fib(10); // [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
```

A function can only return once, so it must return an Array. However, if you switch to a generator, it can return one number at a time, returning multiple times in succession. Here is the rewrite using a generator:

```javascript
function* fib(max) {
    var
        t,
        a = 0,
        b = 1,
        n = 0;
    while (n < max) {
        yield a;
        [a, b] = [b, a + b];
        n ++;
    }
    return;
}
```

Let's try calling it directly:

```javascript
fib(5); // fib {[[GeneratorStatus]]: "suspended", [[GeneratorReceiver]]: Window}
```

Calling a generator directly is different from calling a function. fib(5) merely creates a generator object; it has not executed it yet.

There are two ways to invoke a generator object. The first is to keep calling the next() method of the generator object:

```javascript
var f = fib(5);
f.next(); // {value: 0, done: false}
f.next(); // {value: 1, done: false}
f.next(); // {value: 1, done: false}
f.next(); // {value: 2, done: false}
f.next(); // {value: 3, done: false}
f.next(); // {value: undefined, done: true}
```

The next() method executes the code of the generator, and then, each time it encounters yield x;, it returns an object {value: x, done: true/false} and then "pauses". The returned value is the return value of yield, and done indicates whether this generator has finished executing. If done is true, then value is the return value of return.

When execution reaches the point where done is true, this generator object has completely finished executing, and you should not continue to call next().

The second way is to directly use a for ... of loop to iterate over the generator object. This way does not require us to judge done ourselves:

```javascript
'use strict'

function* fib(max) {
    var
        t,
        a = 0,
        b = 1,
        n = 0;
    while (n < max) {
        yield a;
        [a, b] = [b, a + b];
        n ++;
    }
    return;
}
for (var x of fib(10)) {
    console.log(x); // 依次输出0, 1, 1, 2, 3, ...
}
```

What is the use of a generator compared with an ordinary function?

Because a generator can return multiple times during execution, it looks like a function that can remember the execution state. Using this, writing a single generator can implement functionality that would otherwise require object-oriented programming. For example, to save state with an object, you would have to write it like this:

```javascript
var fib = {
    a: 0,
    b: 1,
    n: 0,
    max: 5,
    next: function () {
        var
            r = this.a,
            t = this.a + this.b;
        this.a = this.b;
        this.b = t;
        if (this.n < this.max) {
            this.n ++;
            return r;
        } else {
            return undefined;
        }
    }
};
```

Using object properties to save state is quite cumbersome.

Another huge benefit of generators is turning asynchronous callback code into "synchronous" code. This benefit can only be appreciated after learning AJAX later.

In the dark age before generators, code had to be written like this when using AJAX:

```javascript
ajax('http://url-1', data1, function (err, result) {
    if (err) {
        return handle(err);
    }
    ajax('http://url-2', data2, function (err, result) {
        if (err) {
            return handle(err);
        }
        ajax('http://url-3', data3, function (err, result) {
            if (err) {
                return handle(err);
            }
            return success(result);
        });
    });
});
```

The more callbacks, the uglier the code.

In the beautiful age of generators, code can be written like this when using AJAX:

```javascript
try {
    r1 = yield ajax('http://url-1', data1);
    r2 = yield ajax('http://url-2', data2);
    r3 = yield ajax('http://url-3', data3);
    success(r3);
}
catch (err) {
    handle(err);
}
```

It looks like synchronous code, but the actual execution is asynchronous.

## Object-Oriented Programming

All data in JavaScript can be regarded as objects, so does that mean we are already using object-oriented programming?

Of course not. If we only use Number, Array, string, and objects defined with the basic {...}, we cannot yet unleash the power of object-oriented programming.

Object-oriented programming in JavaScript is quite different from that in most other languages, such as Java and C#. If you are familiar with Java or C#, good; you must understand the two basic concepts of object orientation:

-   1. Class: a class is a type template for objects. For example, define a Student class to represent students. A class itself is a type; Student represents the student type, but does not represent any specific student;

-   2. Instance: an instance is an object created according to a class. For example, multiple instances such as xiaoming, xiaohong, and xiaojun can be created from the Student class. Each instance represents a specific student, and they all belong to the Student type.

Therefore, classes and instances are the basic concepts of most object-oriented programming languages.

However, in JavaScript, this concept needs to be modified. JavaScript does not distinguish between the concepts of class and instance, but instead implements object-oriented programming through prototypes (prototype).

A prototype means that when we want to create the specific student xiaoming, we do not have a Student type available. So what should we do? It happens that there is a ready-made object:

```javascript
var robot = {
    name: 'Robot',
    height: 1.6,
    run: function () {
        console.log(this.name + ' is running...');
    }
};
```

We see that this robot object has a name, a height, and can run. It is a bit like Xiaoming, so let's just "create" Xiaoming based on it!

So we rename it to Student, and then create xiaoming:

```javascript
var Student = {
    name: 'Robot',
    height: 1.2,
    run: function () {
        console.log(this.name + ' is running...');
    }
};

var xiaoming = {
    name: '小明'
};

xiaoming.__proto__ = Student;
```

Note that the last line of code points the prototype of xiaoming to the object Student, so it looks as if xiaoming were inherited from Student:

```javascript
xiaoming.name; // '小明'
xiaoming.run(); // 小明 is running...
```

xiaoming has its own name property, but the run() method is not defined. However, since Xiaoming is inherited from Student, as long as Student has the run() method, xiaoming can also call it:

![prototype](prototype.png)

The difference between JavaScript's prototype chain and Java's Class is that it has no "Class" concept: all objects are instances, and the so-called inheritance relationship is nothing more than pointing the prototype of one object to another object.

If you point the prototype of xiaoming to another object:

```javascript
var Bird = {
    fly: function () {
        console.log(this.name + ' is flying...');
    }
};

xiaoming.__proto__ = Bird;
```

Now xiaoming can no longer run(); it has become a bird:

```javascript
xiaoming.fly(); // 小明 is flying...
```

While the JavaScript code is running, you can change xiaoming from Student into Bird, or into any object.

Please note that the above code is for demonstration purposes only. When writing JavaScript code, do not directly use obj.**proto** to change the prototype of an object, and older versions of IE cannot use **proto** either. The Object.create() method can take a prototype object and create a new object based on that prototype, but the new object has no properties at all. Therefore, we can write a function to create xiaoming:

```javascript
// 原型对象:
var Student = {
    name: 'Robot',
    height: 1.2,
    run: function () {
        console.log(this.name + ' is running...');
    }
};

function createStudent(name) {
    // 基于Student原型创建一个新对象:
    var s = Object.create(Student);
    // 初始化新对象:
    s.name = name;
    return s;
}

var xiaoming = createStudent('小明');
xiaoming.run(); // 小明 is running...
xiaoming.__proto__ === Student; // true
```

This is one way to create prototype inheritance. JavaScript has other ways to create objects, which we will cover one by one later.

### Creating Objects

JavaScript sets a prototype for every created object, pointing to its prototype object.

When we use obj.xxx to access a property of an object, the JavaScript engine first looks for that property on the current object. If it is not found, it looks on the prototype object. If it is still not found, it keeps going up to the Object.prototype object. Finally, if it is still not found, it can only return undefined.

For example, create an Array object:

```javascript
var arr = [1, 2, 3];
```

Its prototype chain is:

```javascript
arr ----> Array.prototype ----> Object.prototype ----> null
```

When we create a function:

```javascript
function foo() {
    return 0;
}
```

A function is also an object, and its prototype chain is:

```javascript
foo ----> Function.prototype ----> Object.prototype ----> null
```

Since Function.prototype defines methods such as apply(), all functions can call the apply() method.

It is easy to imagine that if the prototype chain is very long, accessing a property of an object will become slower because more time is spent searching. Therefore, be careful not to make the prototype chain too long.

**Constructor Functions**

Besides creating an object directly with { ... }, JavaScript can also use a constructor function to create an object. To use it, first define a constructor function:

```javascript
function Student(name) {
    this.name = name;
    this.hello = function () {
        alert('Hello, ' + this.name + '!');
    }
}
```

You may ask: hey, isn't this just an ordinary function?

This is indeed an ordinary function, but in JavaScript, the new keyword can be used to call this function and return an object:

```javascript
var xiaoming = new Student('小明');
xiaoming.name; // '小明'
xiaoming.hello(); // Hello, 小明!
```

Note that if you do not write new, this is an ordinary function and it returns undefined. However, if you write new, it becomes a constructor function: its bound this points to the newly created object, and it returns this by default, which means you do not need to write return this; at the end.

The prototype chain of the newly created xiaoming is:

```javascript
xiaoming ----> Student.prototype ----> Object.prototype ----> null
```

In other words, the prototype of xiaoming points to the prototype of the function Student. If you also create xiaohong and xiaojun, then the prototypes of these objects are the same as xiaoming's:

```javascript
xiaoming ↘
xiaohong -→ Student.prototype ----> Object.prototype ----> null
xiaojun  ↗
```

An object created with new Student() also obtains a constructor property from the prototype, which points to the function Student itself:

```javascript
xiaoming.constructor === Student.prototype.constructor; // true
Student.prototype.constructor === Student; // true

Object.getPrototypeOf(xiaoming) === Student.prototype; // true

xiaoming instanceof Student; // true
```

Dizzy yet? Here is a diagram to represent these messy relationships:

![constructor](constructor.png)

The red arrows are the prototype chain. Note that the object pointed to by Student.prototype is the prototype object of xiaoming and xiaohong, and this prototype object itself has a property constructor that points to the function Student itself.

In addition, the function Student happens to have a property prototype that points to the prototype object of xiaoming and xiaohong, but the objects xiaoming and xiaohong do not have the prototype property. However, it can be viewed using the non-standard usage **proto**.

For now, we consider the objects xiaoming and xiaohong to be "inherited" from Student.

However, there is still a small problem. Observe carefully:

```javascript
xiaoming.name; // '小明'
xiaohong.name; // '小红'
xiaoming.hello; // function: Student.hello()
xiaohong.hello; // function: Student.hello()
xiaoming.hello === xiaohong.hello; // false
```

The names of xiaoming and xiaohong are different, which is correct; otherwise we could not tell who is who.

The hello of xiaoming and the hello of xiaohong are each a function, but they are two different functions, even though the function names and code are identical!

If we create many objects through new Student(), the hello functions of these objects actually only need to share the same function, which can save a lot of memory.

To make the created objects share a single hello function, according to the object property lookup principle, we only need to move the hello function to the prototype shared by the objects xiaoming and xiaohong, that is, Student.prototype:

### Prototype Inheritance

### class Inheritance

### Standard Objects

## Errors and Exception Handling

## IO Programming

## Processes and Threads

## Regular Expressions

## Common Built-in Modules

### Date and Time

### Dynamic Image Processing

### XML

## Third-Party Modules

## Graphical User Interface

## Network Programming

## Database Access

## Template Engines

## MVC/Web Development

## Asynchronous IO

## Frameworks
