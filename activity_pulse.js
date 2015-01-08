Activities = new Mongo.Collection("activities");

var unitsMap = { // As per Moment.js
  'm': 'minutes',
  'h': 'hours',
  'd': 'days',
  'w': 'weeks',
  'M': 'months'
};

if (Meteor.isClient) {
  Meteor.subscribe("activities");
  Template.registerHelper("SGet", function (svar) {
    return Session.get(svar);
  });
  Template.registerHelper("SEql", function (svar, sval) {
    return Session.equals(svar, sval);
  });
  Session.setDefault("showHelp", true);

  Meteor.setInterval(function () {
    Session.set("tick", new Date);
  }, 60 * 1000);

  Template.help.events({
    'click a.hide-help': function () {
      Session.set("showHelp", ! Session.get("showHelp"));
    }
  });

  Template.toggleHelp.events({
    'click a': function () {
      Session.set("showHelp", ! Session.get("showHelp"));
    }
  });

  var numBehind = function (activity) {
    var lastPulse = moment(activity.lastPulse);
    var now = moment();
    var nb = 0;
    lastPulse.add(activity.recur[0], activity.recur[1]);
    while (lastPulse.isBefore(now)) {
      nb += 1;
      lastPulse.add(activity.recur[0], activity.recur[1]);
    }
    return nb;
  };

  Template.activitiesList.helpers({
    activities: function () {
      Session.get("tick"); // trigger update every minute

      // "numBehind" not cached in activity, so need to fetch() for sorting.
      return _.sortBy(Activities.find().fetch(), numBehind).reverse();
    }
  });

  Template.activityItem.helpers({
    numBehind: function () {
      Session.get("tick"); // trigger update every minute
      return numBehind(this);
    },
    state: function () {
      Session.get("tick"); // trigger update every minute
      var nb = numBehind(this);
      if (nb < 2) {
        return "success";
      } else if (nb < 4) {
        return "warning";
      } else {
        return "danger";
      }
    },
    recurrence: function () {
      var n = this.recur[0];
      var units = unitsMap[this.recur[1]];
      if (n === 1) {
        units = units.substring(0,units.length - 1);
      }
      return n + " " + units;
    },
    prevLastPulse: function () {
      var p = Session.get("prevLastPulse");
      return p && p._id === this._id;
    },
    lastPulse: function () {
      Session.get("tick"); // trigger update every minute
      return moment(this.lastPulse).fromNow();
    }
  });

  Template.activityItem.events({
    'click button.edit': function () {
      if (Session.equals("editing", this._id)) {
        Session.set("editing", null);
      } else {
        Session.set("editing", this._id);
      }
    },
    'click button.remove': function () {
      if (confirm('Are you sure?')) {
        Meteor.call("removeActivity", this._id);
      }
    },
    // Pulse only once if button is (accidentally) hit multiple times in rapid
    // succession.
    'click button.pulse': _.throttle(function () {
      var p = Session.get("prevLastPulse");
      if (p && p._id === this._id) {
        // Cannot pulse again until grace pediod to undo last pulse has passed.
        return;
      }
      Session.set("prevLastPulse", {_id: this._id, when: this.lastPulse});
      Meteor.call("pulseActivity", this._id, new Date);
    }, 1000, {trailing: false}),
    'click a.undo-pulse': function () {
      var prevLastPulse = Session.get("prevLastPulse");
      if (prevLastPulse && prevLastPulse._id === this._id) {
        Meteor.call("pulseActivity", this._id, prevLastPulse.when);
        Session.set("prevLastPulse", null);
      }
    }
  });

  Template.editableActivity.helpers({
    units: function () {
      return _.pairs(unitsMap);
    },
    unitsSelected: function () {
      var units = this[1];
      if (Session.get("editing")) {
        var activity = Activities.findOne(Session.get("editing"));
        if (unitsMap[activity.recur[1]] === units) {
          return "selected";
        } else {
          return "";
        }
      } else {
        return "";
      }
    }
  });

  Template.editableActivity.events({
    'submit form': function (evt, tmpl) {
      evt.preventDefault();
      var desc = tmpl.$("input[type=text]").val();
      var recur = [];
      recur[0] = parseInt(tmpl.$("input[type=number]").val(), 10);
      recur[1] = tmpl.$("option:selected").val();
      if (this._id) {
        Meteor.call("editActivity", this._id, {desc: desc, recur: recur});
      } else {
        Meteor.call("addActivity", {desc: desc, recur: recur});
      }
      Session.set("editing", null);
    }
  });
}

Recurrence = Match.Where(function (r) {
  check(r, [Match.Any]);
  return r.length === 2 &&
    Match.test(r[0], Match.Integer) &&
    _.contains(_.keys(unitsMap), r[1]);
});

Meteor.methods({
  addActivity: function (activity) {
    check(this.userId, String);
    check(activity, {desc: String, recur: Recurrence});
    var lastPulse = moment();
    // Assume user is behind by two recurrences => "warning"
    _.times(2, function () {
      lastPulse.subtract(activity.recur[0], activity.recur[1]);
    });
    Activities.insert(_.extend(activity, {
      userId: this.userId,
      lastPulse: lastPulse.toDate()
    }));
  },
  editActivity: function (id, toSet) {
    check(this.userId, String);
    check(id, String);
    check(toSet, {desc: String, recur: Recurrence});
    var a = Activities.findOne(id);
    if (! a || a.userId !== this.userId) {
      throw new Meteor.Error(
        "unauthorized", "This isn't your activity to edit.");
    }
    Activities.update(id, {$set: toSet});
  },
  removeActivity: function (id) {
    check(this.userId, String);
    check(id, String);
    var a = Activities.findOne(id);
    if (! a || a.userId !== this.userId) {
      throw new Meteor.Error(
        "unauthorized", "This isn't your activity to remove.");
    }
    Activities.remove(id);
  },
  pulseActivity: function (id, when) {
    check(this.userId, String);
    check(id, String);
    check(when, Date);
    var a = Activities.findOne(id);
    if (! a || a.userId !== this.userId) {
      throw new Meteor.Error(
        "unauthorized", "This isn't your activity to pulse.");
    }
    Activities.update(id, {$set: {lastPulse: when}});
  }
});

if (Meteor.isServer) {
  Activities._ensureIndex({userId: 1});

  Meteor.publish("activities", function () {
    if (this.userId) {
      if (Activities.find({userId: this.userId}).count() === 0) {
        bootstrapFor(this.userId);
      }
      return Activities.find({userId: this.userId});
    } else {
      return [];
    }
  });

  var bootstrapFor = function (userId) {
    if (Activities.find({userId: userId}).count() == 0) {
      var examples = [{
        desc: "take a nap",
        lastPulse: moment().subtract(3, 'd').toDate(),
        recur: [1, 'd']
      }, {
        desc: "call mom",
        lastPulse: moment().subtract(3, 'w').toDate(),
        recur: [1, 'M']
      }, {
        desc: "take a stretch break",
        lastPulse: moment().subtract(45, 'm').toDate(),
        recur: [1, 'h']
      }, {
        desc: "sleep > 8 hours",
        lastPulse: moment().subtract(4, 'd').toDate(),
        recur: [1, 'd']
      }, {
        desc: "progress on Project X",
        lastPulse: moment().subtract(2, 'w').toDate(),
        recur: [2, 'd']
      }];

      _.each(examples, function (example) {
        Activities.insert(_.extend({userId: userId}, example));
      });
    }
  };

}
