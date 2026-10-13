---
title: Quick Start Guide JavaScript
date: 2018-07-18 06:09:18
lang: zh-TW
tags:
- Quick Start Guide
- JavaScript
permalink: zh-tw/2018/07/18/Quick-Start-Guide-JavaScript/
---

## 關於js、瀏覽器、node.js之間關係梳理

| JavaScript | java   |
| :--------- | :----- |
| V8         | JVM    |
| node.js    | JRE    |
| browser    | Applet |

-   JavaScript：腳本語言
-   v8：(瀏覽器內核、node.js內核)相當於java中的JVM(虛擬機字-節碼解釋器)
-   node.js：文件系統I/O、網絡（HTTP、TCP、UDP、DNS、TLS/SSL等）、二進制數據流、加密算法、數據流等等
-   瀏覽器：文檔對象模型（DOM）瀏覽器對象模型（BOM）出於安全考慮，瀏覽器中的js只能操作DOM BOM對象，功能受限。

## 基本語法

### 程序註釋

以`//`開頭直到行末的字符被視為行註釋，註釋是給開發人員看到，JavaScript引擎會自動忽略：

```javascript
// 這是一行註釋
alert('hello'); // 這也是註釋
```

另一種塊註釋是用`/*...*/`把多行字符包裹起來，把一大"塊"視為一個註釋：

```javascript
/* 從這裡開始是塊註釋
仍然是註釋
仍然是註釋
註釋結束 */
```

### 變量

變量的概念基本上和初中代數的方程變量是一致的，只是在計算機程序中，變量不僅可以是數字，還可以是任意數據類型。

變量在JavaScript中就是用一個變量名錶示，變量名是大小寫英文、數字、`$`和`_`的組合，且不能用數字開頭。變量名也不能是JavaScript的關鍵字，如`if`、`while`等。申明一個變量用`var`語句，比如：

```javascript
var a; // 申明瞭變量a，此時a的值為undefined
var $b = 1; // 申明瞭變量$b，同時給$b賦值，此時$b的值為1
var s_007 = '007'; // s_007是一個字符串
var Answer = true; // Answer是一個布爾值true
var t = null; // t的值是null
```

### 變量的類型

-   Number
      JavaScript 只有一種數字類型。數字可以帶小數點，也可以不帶：
    ```javascript
    var x1=123; // 整數123
    var x2=0.456; // 浮點數0.456
    var x3=1.2345e3; // 科學計數法表示1.2345x1000，等同於1234.5
    var x4=-99; // 負數
    var x5=NaN; // NaN表示Not a Number，當無法計算結果時用NaN表示
    var x6=Infinity; // Infinity表示無限大，當數值超過了JavaScript的Number所能表示的最大值時，就表示為Infinity
    ```
-   字符串
    字符串是以單引號'或雙引號"括起來的任意文本，比如`'abc'`，`"xyz"`等等。請注意，`''`或`""`本身只是一種表示方式，不是字符串的一部分，因此，字符串`'abc'`只有`a`，`b`，`c`這3個字符。

    ```javascript
    var answer="Nice to meet you!";
    var answer="He is called 'Bill'";
    var answer='He is called "Bill"';
    ```

-   布爾值
    布爾（邏輯）只能有兩個值：true 或 false。

    ```javascript
    var x=true
    var y=false
    ```

-   數組
    數組是一組按順序排列的集合，集合的每個值稱為元素。JavaScript的數組可以包括任意數據類型。例如：
    ```javascript
    [1, 2, 3.14, 'Hello', null, true];
    ```
-   Map
    Map是一組鍵值對的結構，具有極快的查找速度。

    ```javascript
    var m = new Map([['Michael', 95], ['Bob', 75], ['Tracy', 85]]);
    m.get('Michael'); // 95
    ```

    初始化Map需要一個二維數組，或者直接初始化一個空Map。Map具有以下方法：

    ```javascript
    var m = new Map(); // 空Map
    m.set('Adam', 67); // 添加新的key-value
    m.set('Bob', 59);
    m.has('Adam'); // 是否存在key 'Adam': true
    m.get('Adam'); // 67
    m.delete('Adam'); // 刪除key 'Adam'
    m.get('Adam'); // undefined
    ```

    由於一個key只能對應一個value，所以，多次對一個key放入value，後面的值會把前面的值沖掉：

    ```javascript
    var m = new Map();
    m.set('Adam', 67);
    m.set('Adam', 88);
    m.get('Adam'); // 88
    ```

-   Set

    Set和Map類似，也是一組key的集合，但不存儲value。由於key不能重複，所以，在Set中，沒有重複的key。
    要創建一個Set，需要提供一個Array作為輸入，或者直接創建一個空Set：

    ```JavaScript
    var s1 = new Set(); // 空Set
    var s2 = new Set([1, 2, 3]); // 含1, 2, 3
    ```

    重複元素在Set中自動被過濾：

    ```javascript
    var s = new Set([1, 2, 3, 3, '3']);
    s; // Set {1, 2, 3, "3"}
    ```

    注意數字3和字符串'3'是不同的元素。
    通過add(key)方法可以添加元素到Set中，可以重複添加，但不會有效果：

    ```javascript
    s.add(4);
    s; // Set {1, 2, 3, 4}
    s.add(4);
    s; // 仍然是 Set {1, 2, 3, 4}
    ```

    通過delete(key)方法可以刪除元素：

    ```javascript
    var s = new Set([1, 2, 3]);
    s; // Set {1, 2, 3}
    s.delete(3);
    s; // Set {1, 2}
    ```

-   對象

    JavaScript的對象是一組由鍵-值組成的無序集合，例如：

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

    JavaScript對象的鍵都是字符串類型，值可以是任意數據類型。上述`person`對象一共定義了6個鍵值對，其中每個鍵又稱為對象的屬性，例如，`person`的`name`屬性為`'Bob'`，`zipcode`屬性為`null`。
    要獲取一個對象的屬性，我們用`對象變量.屬性名`的方式：

    ```javascript
    person.name; // 'Bob'
    person.zipcode; // null
    ```

-   Undefined 和 Null

    null表示一個“空”的值，它和0以及空字符串''不同，0是一個數值，''表示長度為0的字符串，而null表示“空”。

    在其他語言中，也有類似JavaScript的null的表示，例如Java也用null，Swift用nil，Python用None表示。但是，在JavaScript中，還有一個和null類似的undefined，它表示“未定義”。

    JavaScript的設計者希望用null表示一個空的值，而undefined表示值未定義。事實證明，這並沒有什麼卵用，區分兩者的意義不大。大多數情況下，我們都應該用null。undefined僅僅在判斷函數參數是否傳遞的情況下有用。

-   strict模式

    JavaScript在設計之初，為了方便初學者學習，並不強制要求用var申明變量。這個設計錯誤帶來了嚴重的後果：如果一個變量沒有通過var申明就被使用，那麼該變量就自動被申明為全局變量：

    ```javascript
    i = 10; // i現在是全局變量
    ```

    在同一個頁面的不同的JavaScript文件中，如果都不用var申明，恰好都使用了變量i，將造成變量i互相影響，產生難以調試的錯誤結果。

    使用var申明的變量則不是全局變量，它的範圍被限制在該變量被申明的函數體內（函數的概念將稍後講解），同名變量在不同的函數體內互不衝突。

    為了修補JavaScript這一嚴重設計缺陷，ECMA在後續規範中推出了strict模式，在strict模式下運行的JavaScript代碼，強制通過var申明變量，未使用var申明變量就使用的，將導致運行錯誤。

    啟用strict模式的方法是在JavaScript代碼的第一行寫上:

    ```javascript
    'use strict';
    ```

    這是一個字符串，不支持strict模式的瀏覽器會把它當做一個字符串語句執行，支持strict模式的瀏覽器將開啟strict模式運行JavaScript。

### 常量

由於var和let申明的是變量，如果要申明一個常量，在ES6之前是不行的，我們通常用全部大寫的變量來表示“這是一個常量，不要修改它的值”：

```javascript
var PI = 3.14;
```

ES6標準引入了新的關鍵字const來定義常量，const與let都具有塊級作用域：

```javascript
'use strict';

const PI = 3.14;
PI = 3; // 某些瀏覽器不報錯，但是無效果！
PI; // 3.14
```

### 運算符

-   運算符 +

    javascript中+運算符有2個作用一是數學意義上的加減，另一種則用於字符串的拼接

    ```javascript
    //數學運算
    y=5;
    z=2;
    x=y+z;
    //字符串的拼接
    txt1="What a very";
    txt2="nice day";
    txt3=txt1+" "+txt2;
    ```

-   JavaScript 算術運算符

    算術運算符用於執行變量與/或值之間的算術運算。
    給定 y=5，下面的表格解釋了這些算術運算符：

| 運算符 | 描述         | 例子     | 結果    |
| --- | ---------- | ------ | ----- |
| +   | 加          | x=y+2  | x=7   |
| -   | 減          | x=y-2  | x=3   |
| \*  | 乘          | x=y\*2 | x=10  |
| /   | 除          | x=y/2  | x=2.5 |
| %   | 求餘數 (保留整數) | x=y%2  | x=y%2 |
| ++  | 累加         | x=++y  | x=6   |
| --  | 遞減         | x=--y  | x=4   |

-   JavaScript 賦值運算符

    賦值運算符用於給 JavaScript 變量賦值。
    給定 x=10 和 y=5，下面的表格解釋了賦值運算符：

| 運算符 | 例子    | 等價於    | 結果   |
| --- | ----- | ------ | ---- |
| =   | x=y   |        | x=5  |
| +=  | x+=y  | x=x+y  | x=15 |
| -=  | x-=y  | x=x-y  | x=5  |
| \*= | x\*=y | x=x\*y | x=50 |
| /=  | x/=y  | x=x/y  | x=2  |
| %=  | x%=y  | x=x%y  | x=0  |

-   JavaScript 比較運算符

    比較運算符在邏輯語句中使用，以測定變量或值是否相等。
    給定 x=5，下面的表格解釋了比較運算符：

| 運算符   |     | 描述       | 例子                           |
| ----- | --- | -------- | ---------------------------- |
| ==    |     | 等於       | x==8 為 false                 |
| ===   |     | 全等（值和類型） | x===5 為 true；x==="5" 為 false |
| !=    |     | 不等於      | x!=8 為 true                  |
| >     |     | 大於       | x>8 為 false                  |
| &lt;  |     | 小於       | x&lt;8 為 true                |
| >=    |     | 大於或等於    | x>=8 為 false                 |
| &lt;= |     | 小於或等於    | x&lt;=8 為 true               |

-   JavaScript 邏輯運算符

    邏輯運算符用於測定變量或值之間的邏輯。
    給定 x=6 以及 y=3，下表解釋了邏輯運算符：

| 運算符  | 描述  | 例子                          |
| ---- | --- | --------------------------- |
| &&   | and | (x &lt; 10 && y > 1) 為 true |
| \|\| | or  | (x==5\|\|y==5) 為 false      |
| !    | not | !(x==y) 為 true              |

-   javascript 條件運算符

    JavaScript 還包含了基於某些條件對變量進行賦值的條件運算符。

    ```javascript
    variablename=(condition)?value1:value2
    ```

### 表達式

## 流程控制結構

### 分支結構

-   if 語句 - 只有當指定條件為 true 時，使用該語句來執行代碼

    ```javascript
    if (time<20)
    {
    x="Good day";
    }
    ```

-   if...else 語句 - 當條件為 true 時執行代碼，當條件為 false 時執行其他代碼

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

-   if...else if....else 語句 - 使用該語句來選擇多個代碼塊之一來執行

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

-   switch 語句 - 使用該語句來選擇多個代碼塊之一來執行

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

-   default 關鍵詞 - 使用 default 關鍵詞來規定匹配不存在時做的事情

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

### 循環結構

-   for - 循環代碼塊一定的次數

    ```javascript
    for (var i=0; i<5; i++)
      {
      x=x + "The number is " + i + "<br>";
      }
    ```

-   for/in - 循環遍歷對象的屬性

    ```javascript
    var person={fname:"John",lname:"Doe",age:25};
    for (x in person)
      {
      txt=txt + person[x];
      }
    ```

-   for/of 具有iterable類型的集合可以通過新的for/of循環來遍歷。

    ```javascript
    var a = ['A', 'B', 'C'];
    var s = new Set(['A', 'B', 'C']);
    var m = new Map([[1, 'x'], [2, 'y'], [3, 'z']]);
    for (var x of a) { // 遍歷Array
        console.log(x);
    }
    for (var x of s) { // 遍歷Set
        console.log(x);
    }
    for (var x of m) { // 遍歷Map
        console.log(x[0] + '=' + x[1]);
    }
    ```

-   forEach() 它接收一個函數，每次迭代就自動回調該函數

    ```javascript
    'use strict';
    var a = ['A', 'B', 'C'];
    a.forEach(function (element, index, array) {
    // element: 指向當前元素的值
    // index: 指向當前索引
    // array: 指向Array對象本身
    console.log(element + ', index = ' + index);
    });
    ```

-   while - 當指定的條件為 true 時循環指定的代碼塊

    ```javascript
    while (i<5)
    {
    x=x + "The number is " + i + "<br>";
    i++;
    }
    ```

-   do/while - 同樣當指定的條件為 true 時循環指定的代碼塊

    ```javascript
    do
      {
      x=x + "The number is " + i + "<br>";
      i++;
      }
    while (i<5);
    ```

### 特殊的流程控制語句

-   Break 語句

    我們已經switch中見到過 break 語句。它用於跳出 switch() 語句。
    break 語句可用於跳出循環。
    break 語句跳出循環後，會繼續執行該循環之後的代碼（如果有的話）：

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

-   Continue 語句

    continue 語句中斷循環中的迭代，如果出現了指定的條件，然後繼續循環中的下一個迭代。
    該例子跳過了值 3：

    ```javascript
    for (i=0;i<=10;i++)
    {
    if (i==3) continue;
    x=x + "The number is " + i + "<br>";
    }
    ```

## 函數

藉助抽象，我們才能不關心底層的具體計算過程，而直接在更高的層次上思考問題。
寫計算機程序也是一樣，函數就是最基本的一種代碼抽象的方式。

### 函數的定義與調用

-   定義

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

    JavaScript的函數也是一個對象，上述定義的`abs()`函數實際上是一個函數對象，而函數名`abs`可以視為指向該函數的變量。

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

-   調用

    ```javascript
    abs(10); // 返回10
    abs(-9); // 返回9
    ```

-   arguments

    JavaScript還有一個免費贈送的關鍵字arguments，它只在函數內部起作用，並且永遠指向當前函數的調用者傳入的所有參數。arguments類似Array但它不是一個Array：
    利用arguments，你可以獲得調用者傳入的所有參數。也就是說，即使函數不定義任何參數，還是可以拿到參數的值：

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

-   rest參數
    由於JavaScript函數允許接收任意個參數，於是我們就不得不用arguments來獲取所有參數：

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

    為了獲取除了已定義參數a、b之外的參數，我們不得不用arguments，並且循環要從索引2開始以便排除前兩個參數，這種寫法很彆扭，只是為了獲得額外的rest參數，有沒有更好的方法？

    ES6標準引入了rest參數，上面的函數可以改寫為：

    ```javascript
    function foo(a, b, ...rest) {
    console.log('a = ' + a);
    console.log('b = ' + b);
    console.log(rest);
    }

    foo(1, 2, 3, 4, 5);
    // 結果:
    // a = 1
    // b = 2
    // Array [ 3, 4, 5 ]

    foo(1);
    // 結果:
    // a = 1
    // b = undefined
    // Array []
    ```

    rest參數只能寫在最後，前面用...標識，從運行結果可知，傳入的參數先綁定a、b，多餘的參數以數組形式交給變量rest，所以，不再需要arguments我們就獲取了全部參數。

    如果傳入的參數連正常定義的參數都沒填滿，也不要緊，rest參數會接收一個空數組（注意不是undefined）。

### 變量作用域與解構賦值

在JavaScript中，用var申明的變量實際上是有作用域的。
如果一個變量在函數體內部申明，則該變量的作用域為整個函數體，在函數體外不可引用該變量：

-   局部 JavaScript 變量

    ```javascript
    'use strict';

    function foo() {
        var x = 1;
        x = x + 1;
    }

    x = x + 2; // ReferenceError! 無法在函數體外引用變量x
    ```

-   變量提升

    JavaScript的函數定義有個特點，它會先掃描整個函數體的語句，把所有申明的變量“提升”到函數頂部：

    ```javascript
    'use strict';

    function foo() {
        var x = 'Hello, ' + y;
        console.log(x);
        var y = 'Bob';
    }

    foo();
    ```

    雖然是strict模式，但語句var x = 'Hello, ' + y;並不報錯，原因是變量y在稍後申明瞭。但是console.log顯示Hello, undefined，說明變量y的值為undefined。這正是因為JavaScript引擎自動提升了變量y的聲明，但不會提升變量y的賦值。

    對於上述foo()函數，JavaScript引擎看到的代碼相當於：

    ```javascript
    function foo() {
    var y; // 提升變量y的申明，此時y為undefined
    var x = 'Hello, ' + y;
    console.log(x);
    y = 'Bob';
    }
    ```

    由於JavaScript的這一怪異的“特性”，我們在函數內部定義變量時，請嚴格遵守“**在函數內部首先申明所有變量**”這一規則。最常見的做法是用一個var申明函數內部用到的所有變量：

    ```javascript
    function foo() {
    var
        x = 1, // x初始化為1
        y = x + 1, // y初始化為2
        z, i; // z和i為undefined
    // 其他語句:
    for (i=0; i<100; i++) {
        ...
    }
    }
    ```


-   全局 JavaScript 變量
    不在任何函數內定義的變量就具有全局作用域。實際上，JavaScript默認有一個全局對象window，全局作用域的變量實際上被綁定到window的一個屬性：

    ```javascript
    'use strict';

    var course = 'Learn JavaScript';
    alert(course); // 'Learn JavaScript'
    alert(window.course); // 'Learn JavaScript'
    ```

    因此，直接訪問全局變量course和訪問window.course是完全一樣的。

    你可能猜到了，由於函數定義有兩種方式，以變量方式var foo = function () {}定義的函數實際上也是一個全局變量，因此，頂層函數的定義也被視為一個全局變量，並綁定到window對象：

    ```javascript
    'use strict';

    function foo() {
        alert('foo');
    }

    foo(); // 直接調用foo()
    window.foo(); // 通過window.foo()調用
    ```

    進一步大膽地猜測，我們每次直接調用的alert()函數其實也是window的一個變量：

    ```javascript
    'use strict';
    window.alert('調用window.alert()');
    // 把alert保存到另一個變量:
    var old_alert = window.alert;
    // 給alert賦一個新函數:
    window.alert = function () {}
    alert('無法用alert()顯示了!');
    // 恢復alert:
    window.alert = old_alert;
    alert('又可以用alert()了!');
    ```

    這說明JavaScript實際上只有一個全局作用域。任何變量（函數也視為變量），如果沒有在當前函數作用域中找到，就會繼續往上查找，最後如果在全局作用域中也沒有找到，則報ReferenceError錯誤。

-   名字空間
    全局變量會綁定到window上，不同的JavaScript文件如果使用了相同的全局變量，或者定義了相同名字的頂層函數，都會造成命名衝突，並且很難被發現。

    減少衝突的一個方法是把自己的所有變量和函數全部綁定到一個全局變量中。例如：

    ```javascript
    // 唯一的全局變量MYAPP:
    var MYAPP = {};

    // 其他變量:
    MYAPP.name = 'myapp';
    MYAPP.version = 1.0;

    // 其他函數:
    MYAPP.foo = function () {
        return 'foo';
    };
    ```

    把自己的代碼全部放入唯一的名字空間MYAPP中，會大大減少全局變量衝突的可能。

    許多著名的JavaScript庫都是這麼幹的：jQuery，YUI，underscore等等。

-   局部作用域

    由於JavaScript的變量作用域實際上是函數內部，我們在for循環等語句塊中是無法定義具有局部作用域的變量的：

    ```javascript
    'use strict';

    function foo() {
        for (var i=0; i<100; i++) {
            //
        }
        i += 100; // 仍然可以引用變量i
    }
    ```

    為了解決塊級作用域，ES6引入了新的關鍵字let，用let替代var可以申明一個塊級作用域的變量：

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

-   解構賦值

    從ES6開始，JavaScript引入瞭解構賦值，可以同時對一組變量進行賦值。

    什麼是解構賦值？我們先看看傳統的做法，如何把一個數組的元素分別賦值給幾個變量：

    ```javascript
    var array = ['hello', 'JavaScript', 'ES6'];
    var x = array[0];
    var y = array[1];
    var z = array[2];
    ```

    現在，在ES6中，可以使用解構賦值，直接對多個變量同時賦值：

    ```javascript
    'use strict';

    // 如果瀏覽器支持解構賦值就不會報錯:
    var [x, y, z] = ['hello', 'JavaScript', 'ES6'];
    ```

    注意，對數組元素進行解構賦值時，多個變量要用[...]括起來。

    如果數組本身還有嵌套，也可以通過下面的形式進行解構賦值，注意嵌套層次和位置要保持一致：

    ```javascript
    let [x, [y, z]] = ['hello', ['JavaScript', 'ES6']];
    x; // 'hello'
    y; // 'JavaScript'
    z; // 'ES6'
    ```

    解構賦值還可以忽略某些元素：

    ```javascript
    let [, , z] = ['hello', 'JavaScript', 'ES6']; // 忽略前兩個元素，只對z賦值第三個元素
    z; // 'ES6'
    ```

    如果需要從一個對象中取出若干屬性，也可以使用解構賦值，便於快速獲取對象的指定屬性：

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

    對一個對象進行解構賦值時，同樣可以直接對嵌套的對象屬性進行賦值，只要保證對應的層次是一致的：

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
    zip; // undefined, 因為屬性名是zipcode而不是zip
    // 注意: address不是變量，而是為了讓city和zip獲得嵌套的address對象的屬性:
    address; // Uncaught ReferenceError: address is not defined
    ```

    使用解構賦值對對象屬性進行賦值時，如果對應的屬性不存在，變量將被賦值為undefined，這和引用一個不存在的屬性獲得undefined是一致的。如果要使用的變量名和屬性名不一致，可以用下面的語法獲取：

    ```javascript
    var person = {
    name: '小明',
    age: 20,
    gender: 'male',
    passport: 'G-12345678',
    school: 'No.4 middle school'
    };

    // 把passport屬性賦值給變量id:
    let {name, passport:id} = person;
    name; // '小明'
    id; // 'G-12345678'
    // 注意: passport不是變量，而是為了讓變量id獲得passport屬性:
    passport; // Uncaught ReferenceError: passport is not defined
    ```

    解構賦值還可以使用默認值，這樣就避免了不存在的屬性返回undefined的問題：

    ```javascript
    var person = {
    name: '小明',
    age: 20,
    gender: 'male',
    passport: 'G-12345678'
    };

    // 如果person對象沒有single屬性，默認賦值為true:
    var {name, single=true} = person;
    name; // '小明'
    single; // true
    ```

    有些時候，如果變量已經被聲明瞭，再次賦值的時候，正確的寫法也會報語法錯誤：

    ```javascript
    // 聲明變量:
    var x, y;
    // 解構賦值:
    {x, y} = { name: '小明', x: 100, y: 200};
    // 語法錯誤: Uncaught SyntaxError: Unexpected token =
    ```

    這是因為JavaScript引擎把{開頭的語句當作了塊處理，於是=不再合法。解決方法是用小括號括起來：

    ```javascript
    ({x, y} = { name: '小明', x: 100, y: 200});
    ```

### 方法

在一個對象中綁定函數，稱為這個對象的方法。

在JavaScript中，對象的定義是這樣的：

```javascript
var xiaoming = {
    name: '小明',
    birth: 1990
};
```

但是，如果我們給xiaoming綁定一個函數，就可以做更多的事情。比如，寫個age()方法，返回xiaoming的年齡：

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
xiaoming.age(); // 今年調用是25,明年調用就變成26了
```

綁定到對象上的函數稱為方法，和普通函數也沒啥區別，但是它在內部使用了一個this關鍵字，這個東東是什麼？

在一個方法內部，this是一個特殊變量，它始終指向當前對象，也就是xiaoming這個變量。所以，this.birth可以拿到xiaoming的birth屬性。

讓我們拆開寫：

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

xiaoming.age(); // 25, 正常結果
getAge(); // NaN
```

單獨調用函數getAge()怎麼返回了NaN？請注意，我們已經進入到了JavaScript的一個大坑裡。

JavaScript的函數內部如果調用了this，那麼這個this到底指向誰？

答案是，視情況而定！

如果以對象的方法形式調用，比如xiaoming.age()，該函數的this指向被調用的對象，也就是xiaoming，這是符合我們預期的。

如果單獨調用函數，比如getAge()，此時，該函數的this指向全局對象，也就是window。

坑爹啊！

更坑爹的是，如果這麼寫：

```javascript
var fn = xiaoming.age; // 先拿到xiaoming的age函數
fn(); // NaN
```

也是不行的！要保證this指向正確，必須用obj.xxx()的形式調用！

由於這是一個巨大的設計錯誤，要想糾正可沒那麼簡單。ECMA決定，在strict模式下讓函數的this指向undefined，因此，在strict模式下，你會得到一個錯誤：

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

這個決定只是讓錯誤及時暴露出來，並沒有解決this應該指向的正確位置。

有些時候，喜歡重構的你把方法重構了一下：

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

結果又報錯了！原因是this指針只在age方法的函數內指向xiaoming，在函數內部定義的函數，this又指向undefined了！（在非strict模式下，它重新指向全局對象window！）

修復的辦法也不是沒有，我們用一個that變量首先捕獲this：

```javascript
'use strict';

var xiaoming = {
    name: '小明',
    birth: 1990,
    age: function () {
        var that = this; // 在方法內部一開始就捕獲this
        function getAgeFromBirth() {
            var y = new Date().getFullYear();
            return y - that.birth; // 用that而不是this
        }
        return getAgeFromBirth();
    }
};

xiaoming.age(); // 25
```

用var that = this;，你就可以放心地在方法內部定義其他函數，而不是把所有語句都堆到一個方法中。

-   apply

雖然在一個獨立的函數調用中，根據是否是strict模式，this指向undefined或window，不過，我們還是可以控制this的指向的！

要指定函數的this指向哪個對象，可以用函數本身的apply方法，它接收兩個參數，第一個參數就是需要綁定的this變量，第二個參數是Array，表示函數本身的參數。

用apply修復getAge()調用：

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
getAge.apply(xiaoming, []); // 25, this指向xiaoming, 參數為空
```

另一個與apply()類似的方法是call()，唯一區別是：

apply()把參數打包成Array再傳入；

call()把參數按順序傳入。

比如調用Math.max(3, 5, 4)，分別用apply()和call()實現如下：

```javascript
Math.max.apply(null, [3, 5, 4]); // 5
Math.max.call(null, 3, 5, 4); // 5
```

對普通函數調用，我們通常把this綁定為null。

-   裝飾器

利用apply()，我們還可以動態改變函數的行為。

JavaScript的所有對象都是動態的，即使內置的函數，我們也可以重新指向新的函數。

現在假定我們想統計一下代碼一共調用了多少次parseInt()，可以把所有的調用都找出來，然後手動加上count += 1，不過這樣做太傻了。最佳方案是用我們自己的函數替換掉默認的parseInt()：

```javascript
'use strict';

var count = 0;
var oldParseInt = parseInt; // 保存原函數

window.parseInt = function () {
    count += 1;
    return oldParseInt.apply(null, arguments); // 調用原函數
};
```

### 高階函數

高階函數英文叫Higher-order function。那麼什麼是高階函數？

JavaScript的函數其實都指向某個變量。既然變量可以指向函數，函數的參數能接收變量，那麼一個函數就可以接收另一個函數作為參數，這種函數就稱之為高階函數。

一個最簡單的高階函數：

```javascript
function add(x, y, f) {
    return f(x) + f(y);
}
```

當我們調用add(-5, 6, Math.abs)時，參數x，y和f分別接收-5，6和函數Math.abs，根據函數定義，我們可以推導計算過程為：

```javascript
x = -5;
y = 6;
f = Math.abs;
f(x) + f(y) ==> Math.abs(-5) + Math.abs(6) ==> 11;
return 11;
```

編寫高階函數，就是讓函數的參數能夠接收別的函數。

-   map/reduce

    如果你讀過Google的那篇大名鼎鼎的論文“MapReduce: Simplified Data Processing on Large Clusters”，你就能大概明白map/reduce的概念。<br>
    **map**<br>
    舉例說明，比如我們有一個函數f(x)=x2，要把這個函數作用在一個數組[1, 2, 3, 4, 5, 6, 7, 8, 9]上，就可以用map實現如下：<br>
    ![map](map.png)<br>
    由於map()方法定義在JavaScript的Array中，我們調用Array的map()方法，傳入我們自己的函數，就得到了一個新的Array作為結果：

    ```javascript
    'use strict';

    function pow(x) {
        return x * x;
    }

    var arr = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    var results = arr.map(pow); // [1, 4, 9, 16, 25, 36, 49, 64, 81]
    console.log(results);
    ```

    注意：map()傳入的參數是pow，即函數對象本身。

    你可能會想，不需要map()，寫一個循環，也可以計算出結果：

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

    的確可以，但是，從上面的循環代碼，我們無法一眼看明白“把f(x)作用在Array的每一個元素並把結果生成一個新的Array”。

    所以，map()作為高階函數，事實上它把運算規則抽象了，因此，我們不但可以計算簡單的f(x)=x2，還可以計算任意複雜的函數，比如，把Array的所有數字轉為字符串：

    ```javascript
    var arr = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    arr.map(String); // ['1', '2', '3', '4', '5', '6', '7', '8', '9']
    ```

    只需要一行代碼。<br>
    **reduce**<br>
    再看reduce的用法。Array的reduce()把一個函數作用在這個Array的[x1, x2, x3...]上，這個函數必須接收兩個參數，reduce()把結果繼續和序列的下一個元素做累積計算，其效果就是：

    ```javascript
    [x1, x2, x3, x4].reduce(f) = f(f(f(x1, x2), x3), x4)
    ```

    比方說對一個Array求和，就可以用reduce實現：

    ```javascript
    var arr = [1, 3, 5, 7, 9];
    arr.reduce(function (x, y) {
        return x + y;
    }); // 25
    ```

-   filter
    filter也是一個常用的操作，它用於把Array的某些元素過濾掉，然後返回剩下的元素。

    和map()類似，Array的filter()也接收一個函數。和map()不同的是，filter()把傳入的函數依次作用於每個元素，然後根據返回值是true還是false決定保留還是丟棄該元素。

    例如，在一個Array中，刪掉偶數，只保留奇數，可以這麼寫：

    ```javascript
    var arr = [1, 2, 4, 5, 6, 9, 10, 15];
    var r = arr.filter(function (x) {
        return x % 2 !== 0;
    });
    r; // [1, 5, 9, 15]
    ```

    把一個Array中的空字符串刪掉，可以這麼寫：

    ```javascript
    var arr = ['A', '', 'B', null, undefined, 'C', '  '];
    var r = arr.filter(function (s) {
        return s && s.trim(); // 注意：IE9以下的版本沒有trim()方法
    });
    r; // ['A', 'B', 'C']
    ```

    可見用filter()這個高階函數，關鍵在於正確實現一個“篩選”函數。<br>
    **回調函數**<br>
    filter()接收的回調函數，其實可以有多個參數。通常我們僅使用第一個參數，表示Array的某個元素。回調函數還可以接收另外兩個參數，表示元素的位置和數組本身：

    ```javascript
    var arr = ['A', 'B', 'C'];
    var r = arr.filter(function (element, index, self) {
        console.log(element); // 依次打印'A', 'B', 'C'
        console.log(index); // 依次打印0, 1, 2
        console.log(self); // self就是變量arr
        return true;
    });
    ```

-   sort

    **排序算法**<br>
    排序也是在程序中經常用到的算法。無論使用冒泡排序還是快速排序，排序的核心是比較兩個元素的大小。如果是數字，我們可以直接比較，但如果是字符串或者兩個對象呢？直接比較數學上的大小是沒有意義的，因此，比較的過程必須通過函數抽象出來。通常規定，對於兩個元素x和y，如果認為x &lt; y，則返回-1，如果認為x == y，則返回0，如果認為x > y，則返回1，這樣，排序算法就不用關心具體的比較過程，而是根據比較結果直接排序。
    JavaScript的Array的sort()方法就是用於排序的，但是排序結果可能讓你大吃一驚：

    ```javascript
    // 看上去正常的結果:
    ['Google', 'Apple', 'Microsoft'].sort(); // ['Apple', 'Google', 'Microsoft'];

    // apple排在了最後:
    ['Google', 'apple', 'Microsoft'].sort(); // ['Google', 'Microsoft", 'apple']

    // 無法理解的結果:
    [10, 20, 1, 2].sort(); // [1, 10, 2, 20]
    ```

    第二個排序把apple排在了最後，是因為字符串根據ASCII碼進行排序，而小寫字母a的ASCII碼在大寫字母之後。

    第三個排序結果是什麼鬼？簡單的數字排序都能錯？

    這是因為Array的sort()方法默認把所有元素先轉換為String再排序，結果'10'排在了'2'的前面，因為字符'1'比字符'2'的ASCII碼小。

    如果不知道sort()方法的默認排序規則，直接對數字排序，絕對栽進坑裡！

    幸運的是，sort()方法也是一個高階函數，它還可以接收一個比較函數來實現自定義的排序。

    要按數字大小排序，我們可以這麼寫：

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

    如果要倒序排序，我們可以把大的數放前面：

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

    默認情況下，對字符串排序，是按照ASCII的大小比較的，現在，我們提出排序應該忽略大小寫，按照字母序排序。要實現這個算法，不必對現有代碼大加改動，只要我們能定義出忽略大小寫的比較算法就可以：

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

    忽略大小寫來比較兩個字符串，實際上就是先把字符串都變成大寫（或者都變成小寫），再比較。

    從上述例子可以看出，高階函數的抽象能力是非常強大的，而且，核心代碼可以保持得非常簡潔。

    最後友情提示，sort()方法會直接對Array進行修改，它返回的結果仍是當前Array：

    ```javascript
    var a1 = ['B', 'A', 'C'];
    var a2 = a1.sort();
    a1; // ['A', 'B', 'C']
    a2; // ['A', 'B', 'C']
    a1 === a2; // true, a1和a2是同一對象
    ```

### 閉包

**函數作為返回值**

高階函數除了可以接受函數作為參數外，還可以把函數作為結果值返回。

我們來實現一個對Array的求和。通常情況下，求和的函數是這樣定義的：

```javascript
function sum(arr) {
    return arr.reduce(function (x, y) {
        return x + y;
    });
}

sum([1, 2, 3, 4, 5]); // 15
```

但是，如果不需要立刻求和，而是在後面的代碼中，根據需要再計算怎麼辦？可以不返回求和的結果，而是返回求和的函數！

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

當我們調用lazy_sum()時，返回的並不是求和結果，而是求和函數：

```javascript
var f = lazy_sum([1, 2, 3, 4, 5]); // function sum()
```

調用函數f時，才真正計算求和的結果：

```javascript
f(); // 15
```

在這個例子中，我們在函數lazy_sum中又定義了函數sum，並且，內部函數sum可以引用外部函數lazy_sum的參數和局部變量，當lazy_sum返回函數sum時，相關參數和變量都保存在返回的函數中，這種稱為“閉包（Closure）”的程序結構擁有極大的威力。

請再注意一點，當我們調用lazy_sum()時，每次調用都會返回一個新的函數，即使傳入相同的參數：

```javascript
var f1 = lazy_sum([1, 2, 3, 4, 5]);
var f2 = lazy_sum([1, 2, 3, 4, 5]);
f1 === f2; // false
```

f1()和f2()的調用結果互不影響。

**閉包**

注意到返回的函數在其定義內部引用了局部變量arr，所以，當一個函數返回了一個函數後，其內部的局部變量還被新函數引用，所以，閉包用起來簡單，實現起來可不容易。

另一個需要注意的問題是，返回的函數並沒有立刻執行，而是直到調用了f()才執行。我們來看一個例子：

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

在上面的例子中，每次循環，都創建了一個新的函數，然後，把創建的3個函數都添加到一個Array中返回了。

你可能認為調用f1()，f2()和f3()結果應該是1，4，9，但實際結果是：

```javascript
f1(); // 16
f2(); // 16
f3(); // 16
```

全部都是16！原因就在於返回的函數引用了變量i，但它並非立刻執行。等到3個函數都返回時，它們所引用的變量i已經變成了4，因此最終結果為16。

返回閉包時牢記的一點就是：返回函數不要引用任何循環變量，或者後續會發生變化的變量。

如果一定要引用循環變量怎麼辦？方法是再創建一個函數，用該函數的參數綁定循環變量當前的值，無論該循環變量後續如何更改，已綁定到函數參數的值不變：

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

注意這裡用了一個“創建一個匿名函數並立刻執行”的語法：

```javascript
(function (x) {
    return x * x;
})(3); // 9
```

理論上講，創建一個匿名函數並立刻執行可以這麼寫：

```javascript
function (x) { return x * x } (3);
```

但是由於JavaScript語法解析的問題，會報SyntaxError錯誤，因此需要用括號把整個函數定義括起來：

```javascript
(function (x) { return x * x }) (3);
```

通常，一個立即執行的匿名函數可以把函數體拆開，一般這麼寫：

```javascript
(function (x) {
    return x * x;
})(3);
```

說了這麼多，難道閉包就是為了返回一個函數然後延遲執行嗎？

當然不是！閉包有非常強大的功能。舉個栗子：

在面向對象的程序設計語言裡，比如Java和C++，要在對象內部封裝一個私有變量，可以用private修飾一個成員變量。

在沒有class機制，只有函數的語言裡，藉助閉包，同樣可以封裝一個私有變量。我們用JavaScript創建一個計數器：

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

它用起來像這樣：

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

在返回的對象中，實現了一個閉包，該閉包攜帶了局部變量x，並且，從外部代碼根本無法訪問到變量x。換句話說，閉包就是攜帶狀態的函數，並且它的狀態可以完全對外隱藏起來。

閉包還可以把多參數的函數變成單參數的函數。例如，要計算xy可以用Math.pow(x, y)函數，不過考慮到經常計算x2或x3，我們可以利用閉包創建新的函數pow2和pow3：

```javascript
'use strict';

function make_pow(n) {
    return function (x) {
        return Math.pow(x, n);
    }
}
// 創建兩個新函數:
var pow2 = make_pow(2);
var pow3 = make_pow(3);

console.log(pow2(5)); // 25
console.log(pow3(7)); // 343
```

**腦洞大開**

很久很久以前，有個叫阿隆佐·邱奇的帥哥，發現只需要用函數，就可以用計算機實現運算，而不需要0、1、2、3這些數字和+、-、\*、/這些符號。

JavaScript支持函數，所以可以用JavaScript用函數來寫這些計算。來試試：

```javascript
'use strict';

// 定義數字0:
var zero = function (f) {
    return function (x) {
        return x;
    }
};

// 定義數字1:
var one = function (f) {
    return function (x) {
        return f(x);
    }
};

// 定義加法:
function add(n, m) {
    return function (f) {
        return function (x) {
            return m(f)(n(f)(x));
        }
    }
}
```

### 箭頭函數

ES6標準新增了一種新的函數：Arrow Function（箭頭函數）。

為什麼叫Arrow Function？因為它的定義用的就是一個箭頭：

```javascript
x => x * x
```

上面的箭頭函數相當於：

```javascript
function (x) {
    return x * x;
}
```

箭頭函數相當於匿名函數，並且簡化了函數定義。箭頭函數有兩種格式，一種像上面的，只包含一個表達式，連{ ... }和return都省略掉了。還有一種可以包含多條語句，這時候就不能省略{ ... }和return：

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

如果參數不是一個，就需要用括號()括起來：

```javascript
// 兩個參數:
(x, y) => x * x + y * y

// 無參數:
() => 3.14

// 可變參數:
(x, y, ...rest) => {
    var i, sum = x + y;
    for (i=0; i<rest.length; i++) {
        sum += rest[i];
    }
    return sum;
}
```

如果要返回一個對象，就要注意，如果是單表達式，這麼寫的話會報錯：

```javascript
// SyntaxError:
x => { foo: x }
```

因為和函數體的{ ... }有語法衝突，所以要改為：

```javascript
// ok:
x => ({ foo: x })
```

**this**
箭頭函數看上去是匿名函數的一種簡寫，但實際上，箭頭函數和匿名函數有個明顯的區別：箭頭函數內部的this是詞法作用域，由上下文確定。

回顧前面的例子，由於JavaScript函數對this綁定的錯誤處理，下面的例子無法得到預期結果：

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

現在，箭頭函數完全修復了this的指向，this總是指向詞法作用域，也就是外層調用者obj：

```javascript
var obj = {
    birth: 1990,
    getAge: function () {
        var b = this.birth; // 1990
        var fn = () => new Date().getFullYear() - this.birth; // this指向obj對象
        return fn();
    }
};
obj.getAge(); // 25
```

如果使用箭頭函數，以前的那種hack寫法：

```javascript
var that = this;
```

就不再需要了。

由於this在箭頭函數中已經按照詞法作用域綁定了，所以，用call()或者apply()調用箭頭函數時，無法對this進行綁定，即傳入的第一個參數被忽略：

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

generator（生成器）是ES6標準引入的新的數據類型。一個generator看上去像一個函數，但可以返回多次。

ES6定義generator標準的哥們借鑑了Python的generator的概念和語法，如果你對Python的generator很熟悉，那麼ES6的generator就是小菜一碟了。如果你對Python還不熟，趕快惡補Python教程！。

我們先複習函數的概念。一個函數是一段完整的代碼，調用一個函數就是傳入參數，然後返回結果：

```javascript
function foo(x) {
    return x + x;
}

var r = foo(1); // 調用foo函數
```

函數在執行過程中，如果沒有遇到return語句（函數末尾如果沒有return，就是隱含的return undefined;），控制權無法交回被調用的代碼。

generator跟函數很像，定義如下：

```javascript
function* foo(x) {
    yield x + 1;
    yield x + 2;
    return x + 3;
}
```

generator和函數不同的是，generator由function_定義（注意多出的_號），並且，除了return語句，還可以用yield返回多次。

大多數同學立刻就暈了，generator就是能夠返回多次的“函數”？返回多次有啥用？

還是舉個栗子吧。

我們以一個著名的斐波那契數列為例，它由0，1開頭：

```javascript
0 1 1 2 3 5 8 13 21 34 ...
```

要編寫一個產生斐波那契數列的函數，可以這麼寫：

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

// 測試:
fib(5); // [0, 1, 1, 2, 3]
fib(10); // [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
```

函數只能返回一次，所以必須返回一個Array。但是，如果換成generator，就可以一次返回一個數，不斷返回多次。用generator改寫如下：

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

直接調用試試：

```javascript
fib(5); // fib {[[GeneratorStatus]]: "suspended", [[GeneratorReceiver]]: Window}
```

直接調用一個generator和調用函數不一樣，fib(5)僅僅是創建了一個generator對象，還沒有去執行它。

調用generator對象有兩個方法，一是不斷地調用generator對象的next()方法：

```javascript
var f = fib(5);
f.next(); // {value: 0, done: false}
f.next(); // {value: 1, done: false}
f.next(); // {value: 1, done: false}
f.next(); // {value: 2, done: false}
f.next(); // {value: 3, done: false}
f.next(); // {value: undefined, done: true}
```

next()方法會執行generator的代碼，然後，每次遇到yield x;就返回一個對象{value: x, done: true/false}，然後“暫停”。返回的value就是yield的返回值，done表示這個generator是否已經執行結束了。如果done為true，則value就是return的返回值。

當執行到done為true時，這個generator對象就已經全部執行完畢，不要再繼續調用next()了。

第二個方法是直接用for ... of循環迭代generator對象，這種方式不需要我們自己判斷done：

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
    console.log(x); // 依次輸出0, 1, 1, 2, 3, ...
}
```

generator和普通函數相比，有什麼用？

因為generator可以在執行過程中多次返回，所以它看上去就像一個可以記住執行狀態的函數，利用這一點，寫一個generator就可以實現需要用面向對象才能實現的功能。例如，用一個對象來保存狀態，得這麼寫：

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

用對象的屬性來保存狀態，相當繁瑣。

generator還有另一個巨大的好處，就是把異步回調代碼變成“同步”代碼。這個好處要等到後面學了AJAX以後才能體會到。

沒有generator之前的黑暗時代，用AJAX時需要這麼寫代碼：

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

回調越多，代碼越難看。

有了generator的美好時代，用AJAX時可以這麼寫：

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

看上去是同步的代碼，實際執行是異步的。

## 面向對象的程序設計

JavaScript的所有數據都可以看成對象，那是不是我們已經在使用面向對象編程了呢？

當然不是。如果我們只使用Number、Array、string以及基本的{...}定義的對象，還無法發揮出面向對象編程的威力。

JavaScript的面向對象編程和大多數其他語言如Java、C#的面向對象編程都不太一樣。如果你熟悉Java或C#，很好，你一定明白麵向對象的兩個基本概念：

-   1.類：類是對象的類型模板，例如，定義Student類來表示學生，類本身是一種類型，Student表示學生類型，但不表示任何具體的某個學生；

-   2.實例：實例是根據類創建的對象，例如，根據Student類可以創建出xiaoming、xiaohong、xiaojun等多個實例，每個實例表示一--個具體的學生，他們全都屬於Student類型。

所以，類和實例是大多數面向對象編程語言的基本概念。

不過，在JavaScript中，這個概念需要改一改。JavaScript不區分類和實例的概念，而是通過原型（prototype）來實現面向對象編程。

原型是指當我們想要創建xiaoming這個具體的學生時，我們並沒有一個Student類型可用。那怎麼辦？恰好有這麼一個現成的對象：

```javascript
var robot = {
    name: 'Robot',
    height: 1.6,
    run: function () {
        console.log(this.name + ' is running...');
    }
};
```

我們看這個robot對象有名字，有身高，還會跑，有點像小明，乾脆就根據它來“創建”小明得了！

於是我們把它改名為Student，然後創建出xiaoming：

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

注意最後一行代碼把xiaoming的原型指向了對象Student，看上去xiaoming彷彿是從Student繼承下來的：

```javascript
xiaoming.name; // '小明'
xiaoming.run(); // 小明 is running...
```

xiaoming有自己的name屬性，但並沒有定義run()方法。不過，由於小明是從Student繼承而來，只要Student有run()方法，xiaoming也可以調用：

![prototype](prototype.png)

JavaScript的原型鏈和Java的Class區別就在，它沒有“Class”的概念，所有對象都是實例，所謂繼承關係不過是把一個對象的原型指向另一個對象而已。

如果你把xiaoming的原型指向其他對象：

```javascript
var Bird = {
    fly: function () {
        console.log(this.name + ' is flying...');
    }
};

xiaoming.__proto__ = Bird;
```

現在xiaoming已經無法run()了，他已經變成了一隻鳥：

```javascript
xiaoming.fly(); // 小明 is flying...
```

在JavaScrip代碼運行時期，你可以把xiaoming從Student變成Bird，或者變成任何對象。

請注意，上述代碼僅用於演示目的。在編寫JavaScript代碼時，不要直接用obj.**proto**去改變一個對象的原型，並且，低版本的IE也無法使用**proto**。Object.create()方法可以傳入一個原型對象，並創建一個基於該原型的新對象，但是新對象什麼屬性都沒有，因此，我們可以編寫一個函數來創建xiaoming：

```javascript
// 原型對象:
var Student = {
    name: 'Robot',
    height: 1.2,
    run: function () {
        console.log(this.name + ' is running...');
    }
};

function createStudent(name) {
    // 基於Student原型創建一個新對象:
    var s = Object.create(Student);
    // 初始化新對象:
    s.name = name;
    return s;
}

var xiaoming = createStudent('小明');
xiaoming.run(); // 小明 is running...
xiaoming.__proto__ === Student; // true
```

這是創建原型繼承的一種方法，JavaScript還有其他方法來創建對象，我們在後面會一一講到。

### 創建對象

JavaScript對每個創建的對象都會設置一個原型，指向它的原型對象。

當我們用obj.xxx訪問一個對象的屬性時，JavaScript引擎先在當前對象上查找該屬性，如果沒有找到，就到其原型對象上找，如果還沒有找到，就一直上溯到Object.prototype對象，最後，如果還沒有找到，就只能返回undefined。

例如，創建一個Array對象：

```javascript
var arr = [1, 2, 3];
```

其原型鏈是：

```javascript
arr ----> Array.prototype ----> Object.prototype ----> null
```

當我們創建一個函數時：

```javascript
function foo() {
    return 0;
}
```

函數也是一個對象，它的原型鏈是：

```javascript
foo ----> Function.prototype ----> Object.prototype ----> null
```

由於Function.prototype定義了apply()等方法，因此，所有函數都可以調用apply()方法。

很容易想到，如果原型鏈很長，那麼訪問一個對象的屬性就會因為花更多的時間查找而變得更慢，因此要注意不要把原型鏈搞得太長。

**構造函數**
除了直接用{ ... }創建一個對象外，JavaScript還可以用一種構造函數的方法來創建對象。它的用法是，先定義一個構造函數：

```javascript
function Student(name) {
    this.name = name;
    this.hello = function () {
        alert('Hello, ' + this.name + '!');
    }
}
```

你會問，咦，這不是一個普通函數嗎？

這確實是一個普通函數，但是在JavaScript中，可以用關鍵字new來調用這個函數，並返回一個對象：

```javascript
var xiaoming = new Student('小明');
xiaoming.name; // '小明'
xiaoming.hello(); // Hello, 小明!
```

注意，如果不寫new，這就是一個普通函數，它返回undefined。但是，如果寫了new，它就變成了一個構造函數，它綁定的this指向新創建的對象，並默認返回this，也就是說，不需要在最後寫return this;。

新創建的xiaoming的原型鏈是：

```javascript
xiaoming ----> Student.prototype ----> Object.prototype ----> null
```

也就是說，xiaoming的原型指向函數Student的原型。如果你又創建了xiaohong、xiaojun，那麼這些對象的原型與xiaoming是一樣的：

```javascript
xiaoming ↘
xiaohong -→ Student.prototype ----> Object.prototype ----> null
xiaojun  ↗
```

用new Student()創建的對象還從原型上獲得了一個constructor屬性，它指向函數Student本身：

```javascript
xiaoming.constructor === Student.prototype.constructor; // true
Student.prototype.constructor === Student; // true

Object.getPrototypeOf(xiaoming) === Student.prototype; // true

xiaoming instanceof Student; // true
```

看暈了吧？用一張圖來表示這些亂七八糟的關係就是：

![constructor](constructor.png)

紅色箭頭是原型鏈。注意，Student.prototype指向的對象就是xiaoming、xiaohong的原型對象，這個原型對象自己還有個屬性constructor，指向Student函數本身。

另外，函數Student恰好有個屬性prototype指向xiaoming、xiaohong的原型對象，但是xiaoming、xiaohong這些對象可沒有prototype這個屬性，不過可以用**proto**這個非標準用法來查看。

現在我們就認為xiaoming、xiaohong這些對象“繼承”自Student。

不過還有一個小問題，注意觀察：

```javascript
xiaoming.name; // '小明'
xiaohong.name; // '小紅'
xiaoming.hello; // function: Student.hello()
xiaohong.hello; // function: Student.hello()
xiaoming.hello === xiaohong.hello; // false
```

xiaoming和xiaohong各自的name不同，這是對的，否則我們無法區分誰是誰了。

xiaoming和xiaohong各自的hello是一個函數，但它們是兩個不同的函數，雖然函數名稱和代碼都是相同的！

如果我們通過new Student()創建了很多對象，這些對象的hello函數實際上只需要共享同一個函數就可以了，這樣可以節省很多內存。

要讓創建的對象共享一個hello函數，根據對象的屬性查找原則，我們只要把hello函數移動到xiaoming、xiaohong這些對象共同的原型上就可以了，也就是Student.prototype：

### 原型繼承

### class繼承

### 標準對象

## 錯誤和異常處理

## IO編程

## 進程和線程

## 正則表達式

## 常用內建模塊

### 日期和時間

### 動態圖像處理

### XML

## 三方功能模塊

## 圖形界面

## 網絡編程

## 訪問數據庫

## 模板引擎

## mvc/web開發

## 異步IO

## 框架
