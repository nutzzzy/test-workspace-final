/** Page sources as UiAutomator2 and XCUITest write them, trimmed to what the mobile tests need. */

export const ANDROID_LOGIN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2220">
  <android.widget.FrameLayout index="0" package="com.shop.app" class="android.widget.FrameLayout" text="" resource-id="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" long-clickable="false" password="false" scrollable="false" selected="false" bounds="[0,0][1080,2220]" displayed="true">
    <android.widget.TextView index="0" package="com.shop.app" class="android.widget.TextView" text="Welcome &amp; sign in" resource-id="com.shop.app:id/title" clickable="false" enabled="true" password="false" bounds="[40,100][1040,180]" displayed="true" />
    <android.widget.EditText index="1" package="com.shop.app" class="android.widget.EditText" text="" hint="Email" resource-id="com.shop.app:id/email" clickable="true" enabled="true" focusable="true" password="false" bounds="[40,300][1040,400]" displayed="true" />
    <android.widget.EditText index="2" package="com.shop.app" class="android.widget.EditText" text="••••" resource-id="com.shop.app:id/password" clickable="true" enabled="true" focusable="true" password="true" bounds="[40,450][1040,550]" displayed="true" />
    <android.widget.Button index="3" package="com.shop.app" class="android.widget.Button" text="Sign in" content-desc="login-button" resource-id="com.shop.app:id/login" clickable="true" enabled="true" password="false" bounds="[40,600][1040,700]" displayed="true" />
    <android.widget.Button index="4" package="com.shop.app" class="android.widget.Button" text="Help" resource-id="" clickable="true" enabled="true" password="false" bounds="[40,750][520,850]" displayed="true" />
    <android.widget.Button index="5" package="com.shop.app" class="android.widget.Button" text="Help" resource-id="" clickable="true" enabled="true" password="false" bounds="[560,750][1040,850]" displayed="true" />
    <android.view.ViewGroup index="6" package="com.shop.app" class="android.view.ViewGroup" text="" resource-id="com.shop.app:id/row_9f3a2b1c4d" clickable="true" enabled="true" password="false" bounds="[0,900][1080,1000]" displayed="true">
      <android.widget.TextView index="0" package="com.shop.app" class="android.widget.TextView" text="Forgot password?" resource-id="" clickable="false" enabled="true" password="false" bounds="[40,920][600,980]" displayed="true" />
    </android.view.ViewGroup>
    <android.widget.Button index="7" package="com.shop.app" class="android.widget.Button" text="Hidden" resource-id="" clickable="true" enabled="true" password="false" bounds="[0,0][0,0]" displayed="true" />
  </android.widget.FrameLayout>
</hierarchy>`;

export const IOS_LOGIN = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Shop" label="Shop" enabled="true" visible="true" accessible="false" x="0" y="0" width="390" height="844" index="0">
    <XCUIElementTypeWindow type="XCUIElementTypeWindow" enabled="true" visible="true" accessible="false" x="0" y="0" width="390" height="844" index="0">
      <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" accessible="false" x="0" y="0" width="390" height="844" index="0">
        <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="Welcome" name="Welcome" label="Welcome" enabled="true" visible="true" accessible="true" x="20" y="80" width="350" height="40" index="0"/>
        <XCUIElementTypeTextField type="XCUIElementTypeTextField" name="email-field" label="" placeholderValue="Email" value="Email" enabled="true" visible="true" accessible="true" x="20" y="160" width="350" height="44" index="1"/>
        <XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField" name="password-field" label="" value="••••" enabled="true" visible="true" accessible="true" x="20" y="220" width="350" height="44" index="2"/>
        <XCUIElementTypeButton type="XCUIElementTypeButton" name="Sign in" label="Sign in" enabled="true" visible="true" accessible="true" x="20" y="290" width="350" height="50" index="3"/>
        <XCUIElementTypeCell type="XCUIElementTypeCell" enabled="true" visible="true" accessible="false" x="0" y="360" width="390" height="60" index="4">
          <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="Orders" name="Orders" label="Orders" enabled="true" visible="true" accessible="true" x="20" y="375" width="200" height="30" index="0"/>
        </XCUIElementTypeCell>
        <XCUIElementTypeButton type="XCUIElementTypeButton" name="gone" label="Gone" enabled="true" visible="false" accessible="true" x="0" y="0" width="10" height="10" index="5"/>
      </XCUIElementTypeOther>
      <XCUIElementTypeKeyboard type="XCUIElementTypeKeyboard" enabled="true" visible="true" accessible="false" x="0" y="600" width="390" height="244" index="1">
        <XCUIElementTypeKey type="XCUIElementTypeKey" name="q" label="q" enabled="true" visible="true" accessible="true" x="0" y="610" width="39" height="50" index="0"/>
        <XCUIElementTypeButton type="XCUIElementTypeButton" name="Return" label="Return" enabled="true" visible="true" accessible="true" x="300" y="790" width="90" height="50" index="1"/>
      </XCUIElementTypeKeyboard>
    </XCUIElementTypeWindow>
  </XCUIElementTypeApplication>
</AppiumAUT>`;
