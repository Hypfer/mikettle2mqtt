# mikettle2mqtt

**This is just a somewhat working prototype.**
It will most likely stay like this since the noble library seems to be unmaintained and rather broken.

Since actively connecting to one device seems to break access to other devices, I moved this from ble2mqtt to a seperate project.

To keep things somewhat reliable, this program exits every time the kettle disconnects.
This is not how anything should ever work at all. You've been warned.

I also had to add some modifications to the noble library to get it working at all. [https://github.com/Hypfer/noble](https://github.com/Hypfer/noble)

## Installation
* git clone
* npm install
* copy config.default.json to config.json and edit for your setup

Since using raw sockets apparently requires root, you might need to run ``sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)`` if you want to run mikettle2mqtt as a regular user like a reasonable human being.

For persistence, you'll find a simple systemd unit file in the deployment folder. Don't forget to specify the correct paths.

## Notes

This library is much better: [https://github.com/drndos/mikettle](https://github.com/drndos/mikettle)
Please build an application with it to make this mess obsolete.