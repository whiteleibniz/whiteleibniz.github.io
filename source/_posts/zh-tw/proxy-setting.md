---
title: 利用虛擬主機搭建代理服務器
search: true
categories:
- 系统配置
tag:
- 代理
- Webstorm
typora-root-url: proxy-setting
lang: zh-TW
---
經常需要訪問國外網站的同學，由於*GFW*的限制導致很多網站無法訪問，本文通過境外虛擬主機，利用socket5轉發技術，搭建代理服務器，從而實現各種網站的自由訪問。
## 準備工作

- 國外虛擬主機：我用的[老薛主機](https://my.laoxuehost.net/aff.php?aff=5278)優惠碼(laoxue25la)一年40元需要開通ssh權限。
- putty：本文利用ssh的端口轉發實現socket5代理。
-  plink：putty包下面的一個工具。
- Firefox瀏覽器：設置瀏覽器的代理服務器用於瀏覽被牆網站。
- webstorm：配置webstorm用於下載插件。

## 配置

##### 為plink.exe新建一個一個快捷方式，然後加入以下參數：
![plink](plink.png)

~~~bash
plink.exe -v -C -N -D 127.0.0.1:7000 -l root -pw password -P 22 xxx.xxx.xxx.xxx
~~~

plink.exe -顯示詳細信息  
-啟用數據壓縮  
-不顯示shell  
-端口動態轉發 代理IP:端口  
-l 遠程主機用戶名  
-pw 自動輸入用戶密碼  
-P 遠程主機端口 遠程主機IP

###### 啟動成功顯示：
![proxy](proxy.png)

###### 1. 瀏覽器配置：
![browse](browser.png)

###### 2. webstorm配置：
![webstorm](webstorm.png)
